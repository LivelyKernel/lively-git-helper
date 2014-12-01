var gitHelper = require('../index.js');

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

    testFileTypeNotExists: function(test) {
        var self = this;
        gitHelper.fileType(this.branch, '.', 'not.exists', function(err, isDir) {
            test.ok(err instanceof Error, 'caught error when checking "' + self.branch + '" for non existing file (non.exists)');
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
            textBuffer = new Buffer('I am ' + randomString);
        // TODO: read tree and make sure the file does not exist
        gitHelper.writeFile(this.branch, '.', 'tests/' + randomString + '.txt', textBuffer, 'utf-8', function(err) {
            test.ifError(err, 'caught error when writing tests/' + randomString + '.txt to "' + self.branch + '"');
            // TODO: read file from master and make sure it was not changed
            gitHelper.unlink(self.branch, '.', 'tests/' + randomString + '.txt', function(err) {
                test.ifError(err, 'caught error when deleting tests/' + randomString + '.txt from "' + self.branch + '"');
                // TODO: read tree and make sure the file does not exist anymore
                test.done();
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
    }

};

module.exports = tests;