var gitHelper = require('../index.js'),
    path = require('path');

function generateRandomStr(len) {
    len = isNaN(len) ? 5 : len;
    var str = '',
        base = '012345679ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for (var i = 0; i < len; i++) {
        str += base.charAt(Math.floor(Math.random() * base.length));
    }
    return str;
}

var tests = {

    setUp: function(callback) {
        this.branch = 'testBranch';
        callback();
    },

    tearDown: function(callback) {
        gitHelper.removeBranch(this.branch, '.', callback);
    },

    testFindGitDir: function(test) {
        var cwd = process.env.PWD;
        gitHelper.gitPath('.', function(err, dir) {
            test.ifError(err, 'caught error when finding git');
            test.equal(cwd, dir, 'did not find git dir at current dir (' + cwd + ' vs. ' + dir + ')');
            gitHelper.gitPath('tests', function(err, dir) {
                test.ifError(err, 'caught error when finding git');
                test.equal(cwd, dir, 'did not find git dir at current dir (' + cwd + ' vs. ' + dir + ')');
                test.done();
            });
        });
    },

    testFindGitDirNotExistent: function(test) {
        var cwd = process.env.PWD;
        gitHelper.gitPath('foobar', function(err, dir) {
            test.ok(err instanceof Error, 'did not get an error when finding git in non-existent directory');
            test.equal('NOTADIR', err.code, 'non-existent directory did not report back "NOTADIR" code');
            test.done();
        });
    },

    testFileTypeIsFile: function(test) {
        var self = this;
        gitHelper.fileType(this.branch, '.', 'package.json', function(err, isDir) {
            test.ifError(err, 'caught error when checking "' + self.branch + '" for package.json');
            test.ok(!isDir, 'package.json in "' + self.branch + '" should not be a directory');
            test.done();
        });
    },

    testFileTypeIsDir: function(test) {
        var self = this;
        gitHelper.fileType(this.branch, '.', 'tests', function(err, isDir) {
            test.ifError(err, 'caught error when checking "' + self.branch + '" for tests');
            test.ok(isDir, 'tests in "' + self.branch + '" should be a directory');
            test.done();
        });
    },

    testFileTypeOfNonGit: function(test) {
        var self = this;
        gitHelper.fileType(this.branch, '/tmp/', 'foobar', function(err, isDir) {
            test.ok(err instanceof Error, 'did not get an error when checking "' + self.branch + '" in non-git directory');
            test.equal('NONGIT', err.code, '/tmp repository did not report back "NONGIT" code');
            test.done();
        });
    },

    testFileTypeNotExists: function(test) {
        var self = this;
        gitHelper.fileType(this.branch, '.', 'not.exists', function(err, isDir) {
            test.ok(err instanceof Error, 'did not get an error when checking "' + self.branch + '" for non existing file (non.exists)');
            test.done();
        });
    },

    testReadDir: function(test) {
        var self = this;
        gitHelper.readDir(this.branch, '.', '', function(err, tree) {
            test.ifError(err, 'caught error when reading root directory of "' + self.branch + '"');
            var entries = Object.getOwnPropertyNames(tree);
            test.ok(entries.indexOf('package.json') > -1, 'package.json could not be found in root directory of "' + self.branch + '"');
            test.equal(tree['package.json'].objectType, 'blob', 'package.json was not of type "blob" in "' + self.branch + '"');
            test.ok(entries.indexOf('tests') > -1, 'tests could not be found in root directory of "' + self.branch + '"');
            test.equal(tree['tests'].objectType, 'tree', 'tests was not of type "tree" in "' + self.branch + '"');
            test.done();
        });
    },

    testFileCreationAndDeletion: function(test) {
        var self = this,
            randomString = generateRandomStr(10),
            textBuffer = new Buffer('I am ' + randomString),
            fileName = 'tests/' + randomString + '.txt';

        gitHelper.readFile(self.branch, '.', fileName, function(err) {
            test.ok(err instanceof Error, 'did not get an error when checking "' + self.branch + '" for ' + fileName);
            gitHelper.writeFile(self.branch, '.', fileName, textBuffer, 'utf-8', function(err) {
                test.ifError(err, 'caught error when writing ' + fileName + ' to "' + self.branch + '"');
                gitHelper.readFile(/* should still not exist on */ 'master', '.', fileName, function(err) {
                    test.ok(err instanceof Error, 'did not get an error when checking "master" for ' + fileName);
                    gitHelper.readFile(/* should exist on */ self.branch, '.', fileName, function(err, buffer) {
                        test.ifError(err, 'caught error when checking "' + self.branch + '" for ' + fileName);
                        test.equal(buffer.toString(), textBuffer.toString(), 'content was not inserted write');
                        gitHelper.unlink(self.branch, '.', fileName, function(err) {
                            test.ifError(err, 'caught error when deleting ' + fileName + ' from "' + self.branch + '"');
                            gitHelper.readFile(self.branch, '.', fileName, function(err) {
                                test.ok(err instanceof Error, 'did not get an error when checking "' + self.branch + '" for ' + fileName + ' after delete');
                                test.done();
                            });
                        });
                    });
                });
            });
        });
    },

    testDirCreationAndDeletion: function(test) {
        var self = this,
            randomString = generateRandomStr(10);
        // TODO: read tree and make sure the dir does not exist
        gitHelper.mkDir(this.branch, '.', 'tests/dir_' + randomString, function(err) {
            test.ifError(err, 'caught error when creating tests/dir_' + randomString + ' in "' + self.branch + '"');
            // TODO: read tree from master and make sure it was not changed
            gitHelper.unlink(self.branch, '.', 'tests/dir_' + randomString, function(err) {
                test.ifError(err, 'caught error when deleting tests/dir_' + randomString + ' from "' + self.branch + '"');
                // TODO: read tree and make sure the dir does not exist anymore
                test.done();
            });
        });
    },

    testIsIgnored: function(test) {
        gitHelper.isIgnored('.', 'node_modules', function(err, ignored) {
            test.ifError(err, 'caught error when checking (working copy) whether node_modules is ignored');
            test.ok(ignored, 'node_modules should be ignored (in the currenty working copy)');

            gitHelper.isIgnored('.', 'package.json', function(err, ignored) {
                test.ifError(err, 'caught error when checking (working copy) whether package.json is ignored');
                test.ok(!ignored, 'package.json should not be ignored (in the currenty working copy)');
                test.done();
            });
        });
    },

    testIsIgnoredInNonGit: function(test) {
        gitHelper.isIgnored('/tmp/', 'foobar', function(err, ignored) {
            test.ok(err instanceof Error, 'did not get an error when checking non-git directory for ignored file');
            test.equal('NONGIT', err.code, '/tmp repository did not report back "NONGIT" code');
            test.done();
        });
    },

    testStats: function(test) {
        var self = this,
            randomString = generateRandomStr(10),
            textBuffer = new Buffer(randomString),
            fileName = 'tests/' + randomString + '.txt',
            startDate = new Date().getTime();

        gitHelper.writeFile(self.branch, '.', fileName, textBuffer, 'utf-8', function(err) {
            test.ifError(err, 'caught error when writing ' + fileName + ' to "' + self.branch + '"');
            gitHelper.fileSize(self.branch, '.', fileName, function(err, size) {
                test.ifError(err, 'caught error when checking file size of  ' + fileName + ' on "' + self.branch + '"');
                test.equal(size, 10, 'could not read the correct file size from ' + fileName + ' on "' + self.branch + '"');
                gitHelper.lastModified(self.branch, '.', fileName, function(err, date) {
                    test.ifError(err, 'caught error when checking last modified of  ' + fileName + ' on "' + self.branch + '"');
                    test.ok(date.getTime() - startDate < 2000, 'could not read the correct last modified from ' + fileName + ' on "' + self.branch + '"');
                    gitHelper.unlink(self.branch, '.', fileName, function(err) {
                        test.ifError(err, 'caught error when deleting ' + fileName + ' from "' + self.branch + '"');
                        test.done();
                    });
                });
            });
        });
    },

    testListBranches: function(test) {
        gitHelper.listBranches('.', function(err, branches) {
            test.ifError(err, 'caught error when reading list of branches');
            test.ok(branches instanceof Array, 'did not get a list of branches back');
            test.ok(branches.indexOf('master') > -1, 'could not find master in the list of branches');
            test.done();
        });
    }

};

module.exports = tests;