var exec = require('child_process').execFile,
    spawn = require('child_process').spawn,
    path = require('path'),
    async = require('async');

var START_COMMIT_MESSAGE = '[LV-CHANGESET-START]',
    TMP_COMMIT_MESSAGE = '[LV-CHANGESET-STASH]',
    FILE_TEMPLATE = {
        fileMode: '100644', // default filemode
        objectType: 'blob',
    },
    DIRECTORY_TEMPLATE = {
        fileMode: '040000', // default dirmode
        objectType: 'tree'
    };


function treeFromString(str, withoutPath) {
    var objects = str.trimRight().split('\n'),
        withoutPath = !!withoutPath;

    if (objects.length == 1 && objects[0] == '') // no directory content
        objects = [];

    return objects.reduce(function(tree, objLine) {
        // ls-tree returns lines in the format of:
        // <mode> SP <type> SP <object> TAB <file> NL
        // (see http://git-scm.com/docs/git-ls-tree)
        var info = objLine.match(/^([0-9]+) (tree|blob) ([0-9a-f]+)\t(.*)$/);
        if (!info) // should not happen!!
            throw new Error('Found weird Git ls-tree info (unparseable): ' + objLine);
        var filename = withoutPath ? path.basename(info[4]) : info[4];
        tree[filename] = {
            fileMode: info[1],
            objectType: info[2],
            objectHash: info[3]
        };
        return tree;
    }, {});
}

function stringFromTree(tree) {
    var lines = Object.getOwnPropertyNames(tree).map(function(filename) {
        var info = tree[filename];
        return info.fileMode + ' ' + info.objectType + ' ' + info.objectHash + '\t' + filename;
    });
    return lines.join('\n');
}

function getOldFileHash(diff) {
    return diff.match(/^index ([0-9a-f]+)\.\./m)[1];
}

function getNewFileHash(diff) {
    return diff.match(/^index [0-9a-f]+\.\.([0-9a-f]+)/m)[1];
}

function getOldFilename(diff) {
    var filename = diff.match(/^\-\-\- (.*)$/m)[1].trim();
    return filename != '/dev/null' ? filename.substr(2) : null;
}

function getNewFilename(diff) {
    var filename = diff.match(/^\+\+\+ (.*)$/m)[1].trim();
    return filename != '/dev/null' ? filename.substr(2) : null;
}

function removeTempFiles(files, tempDir) {
    async.each(files, function(file, callback) {
        fs.unlink(path.join(tempDir, file), callback);
    },
    function() {
        // ignore errors;
    });
}

/********************************************************************************/

function ensureBranch(branch, workingDir, callback) {
    exec('git', ['branch', '--list', branch], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) {
            if (err.code == 128 && !err.killed) // fatal error, mostly not a git repo
                err.code = 'NONGIT';
            return callback(err);
        }
        if (stdout.trim() != '') return callback(); // branch already existing

        // Create a branch but also include everything that is
        // currently pending (uncommited changes, new files, etc.)
        exec('git', ['add', '-A'], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err) return callback(err);
            exec('git', ['commit', '-a', '--allow-empty', '-m', START_COMMIT_MESSAGE], { cwd: workingDir }, function(err, stdout, stderr) {
                if (err) return callback(err);
                exec('git', ['branch', branch], { cwd: workingDir }, function(err, stdout, stderr) {
                    if (err) return callback(err);
                    exec('git', ['reset', '--mixed', 'HEAD^1'], { cwd: workingDir }, function(err, stdout, stderr) {
                        callback(err);
                    });
                });
            });
        });
    });
}

function getFileType(branch, workingDir, fileName, callback) {
    exec('git', ['cat-file', '-t', branch + ':' + fileName], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null, stdout.trimRight() == 'tree');
    });
}

function createHashObject(workingDir, buffer, encoding, callback) {
    var process = spawn('git', ['hash-object', '-t', 'blob', '-w', '--stdin'], { cwd: workingDir }),
        stdout = '',
        stderr = '';
    process.stdout.on('data', function(buffer) {
        stdout += buffer.toString();
    });
    process.stderr.on('data', function(buffer) {
        stderr += buffer.toString();
    });
    process.on('close', function(code) {
        if (code == 0)
            callback(null, { fileHash: stdout.trimRight() } );
        else
            callback(new Error(stderr));
    });
    process.stdin.end(buffer, encoding);
}

function createHashObjectFromFile(workingDir, fileName, callback) {
    exec('git', ['hash-object', '-t', 'blob', '-w', fileName], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null, stdout.trimRight());
    });
}

function listCommits(commitish, workingDir, callback) {
    exec('git', ['rev-list', commitish, '--no-merges', '--pretty=oneline'], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) {
            if (err.code == 128 && !err.killed) // fatal error, mostly not a valid commit(ish)
                err.code = 'NOTACOMMIT';
            return callback(err);
        }
        stdout = stdout.trimRight();
        if (stdout == '') return callback(null, []);
        callback(null, stdout.split('\n').map(function(line) {
            var commit = line.match('^([0-9a-f]+) (.*)$');
            return { commitId: commit[1], message: commit[2] };
        }));
    });
}

function diffCommits(commitish1, commitish2, workingDir, callback) {
    if (workingDir instanceof Function) {
        callback = workingDir;
        workingDir = commitish2;
        commitish2 = ''; // HEAD, master whatever
    }
    exec('git', ['log', '--left-right', '--cherry-pick', '--format=commit %m %H %s%n%N', commitish1 + '...' + commitish2],
        { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) {
            if (err.code == 128 && !err.killed) // fatal error, mostly not a valid commit(ish) combination
                err.code = 'NOTACOMMIT';
            return callback(err);
        }
        stdout = stdout.trimRight();
        if (stdout == '') return callback(null, []);
        callback(null, stdout.split(/commit (?=[<>])/).slice(1).reduce(function(res, lines) {
            var parsed = lines.match(/^([<>]) ([0-9a-f]+) (.*)(?:\n([\s\S]*))?$/m),
                commit = { commitId: parsed[2], message: parsed[3], note: (parsed[4] ? parsed[4].trimRight() : null) };
            if (parsed[1] == '<')
                res.added.push(commit);
            else
                res.missing.push(commit);
            return res;
        }, { added: [], missing: [] }));
    });
}

function readCommit(commitish, workingDir, optBaseDir, callback) {
    if (optBaseDir instanceof Function) {
        callback = optBaseDir;
        optBaseDir = workingDir;
    }
    var relPath = path.relative(optBaseDir, workingDir),
        srcPrefix = 'a/' + (relPath != '' ? relPath + '/' : ''),
        dstPrefix = 'b/' + (relPath != '' ? relPath + '/' : '');
    exec('git', ['--no-pager', 'diff', '-U0', '--full-index', '--src-prefix', srcPrefix, '--dst-prefix', dstPrefix, commitish + '^', commitish],
        { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        var changes = stdout.split('\n').reduce(function(all, line) {
            if (line.trim() != '') {
                if (line.substr(0, 5) == 'diff ')
                    all.push(line);
                else
                    all[all.length -1] += '\n' + line;
            }
            return all;
        }, []);
        callback(null, changes);
    });
}

function getStashHash(branch, workingDir, callback) {
    listCommits('..' + branch, workingDir, function(err, commits) {
        if (err) return callback(err);
        var stash = commits.reduce(function(found, item) {
                if (found) return found;
                return item.message == TMP_COMMIT_MESSAGE ? item : null;
            }, null);
        if (!stash)
            callback(new Error('Could not find stash!'));
        else
            callback(null, stash.commitId);
    });
}

function getBranchesByHash(commitish, workingDir, callback) {
    exec('git', ['branch', '--contains', commitish], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        var branches = stdout.trimRight().split('\n').map(function(branch) {
            return branch.trim();
        });
        callback(null, branches);
    });
}

function getParentHash(commitish, workingDir, callback) {
    exec('git', ['log', '--pretty=%H', '-n', '1', commitish], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null, stdout.trimRight());
    });
}

function getParentHashOfStash(branch, workingDir, fileInfo, callback) {
    exec('git', ['log', '--pretty=%H %s', '-n', '1', branch], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        var lineInfo = stdout.trimRight().match(/^([0-9a-f]+) (.*)$/);
        fileInfo.parent = lineInfo[1];
        var parentMessage = lineInfo[2];
        if (parentMessage == TMP_COMMIT_MESSAGE) {
            // need to ammend last commit
            fileInfo.stash = fileInfo.parent;
            // get real parent's hash
            getParentHash(fileInfo.stash + '^1', workingDir, function(err, parent) {
                if (err) return callback(err);
                fileInfo.parent = parent;
                callback(null, fileInfo);
            });
        } else
            callback(null, fileInfo);
    });
}

function getCurrentTrees(workingDir, fileName, fileInfo, callback) {
    // parent's or stash' trees
    getTree(workingDir, fileName, (fileInfo.stash || fileInfo.parent), function(err, treeInfo) {
        if (err) return callback(err);
        fileInfo.treeInfos = treeInfo;
        callback(null, fileInfo);
    });
}

function getTree(workingDir, fileName, treeish, treeInfo, callback) {
    if ((callback === undefined) && (treeInfo instanceof Function)) {
        callback = treeInfo;
        treeInfo = {};
    }

    var pathParts = fileName.split(path.sep);
    pathParts.pop();
    var paths = pathParts.reduce(function(paths, part) {
        paths.unshift(path.join(paths[0], part) + '/');
        return paths;
    }, ['']);

    async.reduce(paths, treeInfo, function(tree, path, next) {
        if (tree.hasOwnProperty(path)) return next(null, tree);
        exec('git', ['ls-tree', treeish, path], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err) return next(err);
            tree[path] = treeFromString(stdout, true);
            next(null, tree);
        });
    }, callback);
}

function copyFileHash(completeFileName, fileInfo, callback) {
    var dirName = path.dirname(completeFileName),
        fileName = path.basename(completeFileName);
    dirName = (dirName == '.' ? '' : dirName + '/');

    var info = fileInfo.treeInfos[dirName][fileName];
    if (!(info && info.objectHash))
        return callback(new Error('Could not find object to copy (source)!'));
    fileInfo.fileHash = info.objectHash;
    callback(null, fileInfo);
}

function injectHashObjectIntoTree(completeFileName, hash, treeInfo) {
    var dirName = path.dirname(completeFileName),
        fileName = path.basename(completeFileName);
    dirName = (dirName == '.' ? '' : dirName + '/');

    var info = treeInfo[dirName][fileName] = JSON.parse(JSON.stringify(FILE_TEMPLATE)); // ... clone FILE_TEMPLATE
    info.objectHash = hash;
}

function injectHashObjectIntoFileInfo(fileName, fileInfo, callback) {
    injectHashObjectIntoTree(fileName, fileInfo.fileHash, fileInfo.treeInfos);
    callback(null, fileInfo);
}

function injectEmptyDirIntoTree(workingDir, completeDirName, fileInfo, callback) {
    var process = spawn('git', ['mktree'], { cwd: workingDir }),
        stdout = '',
        stderr = '';
    process.stdout.on('data', function(buffer) {
        stdout += buffer.toString();
    });
    process.stderr.on('data', function(buffer) {
        stderr += buffer.toString();
    });
    process.on('close', function(code) {
        if (code != 0)
            return callback(new Error(stderr));
        var parentDir = path.dirname(completeDirName),
            dirName = path.basename(completeDirName);
        parentDir = (parentDir == '.') ? '' : parentDir + '/';
        var info = fileInfo.treeInfos[parentDir][dirName] = JSON.parse(JSON.stringify(DIRECTORY_TEMPLATE)); // ... clone
        info.objectHash = stdout.trimRight() // empty tree hash
        callback(null, fileInfo);
    });
    process.stdin.end();
}

function removeObjectFromTree(completeFileName, fileInfo, callback) {
    var parentDir = path.dirname(completeFileName),
        fileName = path.basename(completeFileName);
    parentDir = (parentDir == '.') ? '' : parentDir + '/';

    delete fileInfo.treeInfos[parentDir][fileName];
    callback(null, fileInfo);
}

function createTrees(workingDir, fileInfo, callback) {
    var changedDirs = Object.getOwnPropertyNames(fileInfo.treeInfos).sort().reverse();
    async.reduce(changedDirs, null, function(hashAndDir, changedDir, callback) {
        var treeInfo = fileInfo.treeInfos[changedDir];
        if (hashAndDir != null) {
            var hash = hashAndDir[0], // undefined otherwise
                prevDir = hashAndDir[1];
        }
        if (hash != null) {
            treeInfo[prevDir] = treeInfo[prevDir] || JSON.parse(JSON.stringify(DIRECTORY_TEMPLATE)); // ... or clone empty dir
            treeInfo[prevDir].objectHash = hash; // update tree with updated hash
        }
        var process = spawn('git', ['mktree'], { cwd: workingDir }),
            stdout = '',
            stderr = '';
        process.stdout.on('data', function(buffer) {
            stdout += buffer.toString();
        });
        process.stderr.on('data', function(buffer) {
            stderr += buffer.toString();
        });
        process.on('close', function(code) {
            if (code != 0)
                return callback(new Error(stderr));
            var newHash = stdout.trimRight();
            callback(null, [newHash, path.basename(changedDir)]);
        });
        process.stdin.end(stringFromTree(treeInfo));
    }, function(err, result) {
        if (err) return callback(err);
        fileInfo.rootTree = result[0];
        callback(null, fileInfo);
    });
}

function createCommit(workingDir, commitInfo, message, fileInfo, callback) {
    message = message || TMP_COMMIT_MESSAGE;
    exec('git', ['commit-tree', fileInfo.rootTree, '-p', fileInfo.parent, '-m', message], { cwd: workingDir, env: commitInfo }, function(err, stdout, stderr) {
        if (err) return callback(err);
        fileInfo.commit = stdout.trimRight();
        callback(null, fileInfo);
    });
}

function createCommitFromDiffs(workingDir, diffs, commitInfo, message, fileInfo, callback) {
    var commitObjects = diffs.reduce(function(list, diff) {
        var hash = getOldFileHash(diff) + '-' + getNewFileHash(diff) + '-' + (getNewFilename(diff) || '');
        if (!list.hasOwnProperty(hash))
            list[hash] = { diffs: [] };
        list[hash].diffs.push(diff);
        return list;
    }, {});

    var tempFiles = [],
        filenames = diffs.map(function(diff) {
            return getNewFilename(diff) || getOldFilename(diff);
        });

    // assemble tree info
    async.reduce(filenames, fileInfo.treeInfos, function(tree, filename, next) {
        if (filename == null) return tree;
        getTree(workingDir, filename, fileInfo.parent, tree, next);
    }, function(err) {
        if (err) return callback(err);

        async.eachSeries(Object.getOwnPropertyNames(commitObjects),
        async.seq(
            function createTempFile(doubleHash, next) {
                // make sure it exists
                var hashes = doubleHash.split('-');
                if ((hashes[0] == '0000000000000000000000000000000000000000') || (hashes[1] == '0000000000000000000000000000000000000000'))
                    return next(null, doubleHash, null);
                exec('git', ['unpack-file', hashes[0]], { cwd: workingDir },
                function(err, stdout, stderr) {
                    if (err) return next(err);
                    var tempFile = stdout.trimRight();
                    commitObjects[doubleHash].tempFile = tempFile;
                    tempFiles.push(tempFile);
                    next(null, doubleHash, tempFile);
                });
            },
            function patchTempFile(doubleHash, tempFile, next) {
                var args = []
                if (tempFile == null) {
                    var hash = doubleHash.split('-')[1];
                    if (hash == '0000000000000000000000000000000000000000')
                        return next(null, doubleHash, null);
                    tempFile = '.merge_file_' + hash.substr(0, 8);
                    tempFiles.push(tempFile);
                    args.push('-o');
                }
                args.push(tempFile);
                var patch = spawn('patch', args, { cwd: workingDir }),
                    stderr = '';
                patch.stderr.on('data', function(buffer) {
                    stderr += buffer.toString();
                });
                patch.on('close', function(code) {
                    if (code == 0)
                        next(null, doubleHash, tempFile);
                    else
                        next(new Error(stderr));
                });
                patch.stdin.end(commitObjects[doubleHash].diffs.join('\n'));
            },
            function saveOrDeleteTempFile(doubleHash, tempFile, next) {
                var newFilename = getNewFilename(commitObjects[doubleHash].diffs[0]);

                if (newFilename == null && tempFile == null) { // DELETE
                    newFilename = getOldFilename(commitObjects[doubleHash].diffs[0]);
                    removeObjectFromTree(newFilename, fileInfo, next);
                    return;
                }

                createHashObjectFromFile(workingDir, tempFile, function(err, hash) {
                    if (err) return next(err);
                    commitObjects[doubleHash].fileHash = hash;
                    injectHashObjectIntoTree(newFilename, hash, fileInfo.treeInfos);
                    next(null);
                });
            }
        ), function(err) {
            removeTempFiles(tempFiles, workingDir);
            if (err) return callback(err);

            async.waterfall([
                createTrees.bind(null, workingDir, fileInfo),
                createCommit.bind(null, workingDir, commitInfo, message),
            ], callback);
        });
    });
}

function updateBranch(branch, workingDir, fileInfo, callback) {
    exec('git', ['update-ref', 'refs/heads/' + branch, fileInfo.commit], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null, fileInfo);
    });
}

function addCommitNote(workingDir, commitId, note, callback) {
    exec('git', ['notes', 'append', '-m', note, commitId], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null);
    });
}

function getCommitNote(workingDir, commitId, callback) {
    exec('git', ['notes', 'show', commitId], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) {
            if (err.code == 1)
                return callback(null, null);
            return callback(new Error(err));
        }
        callback(null, stdout.trimRight());
    });
}

function removeCommitNote(workingDir, commitId, callback) {
    exec('git', ['notes', 'remove', '--ignore-missing', commitId], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null);
    });
}

function findCommonBase(commitish1, commitish2, workingDir, callback) {
    exec('git', ['merge-base', commitish1, commitish2], { cwd: workingDir }, function(err, stdout, stderr) {
        if (err) return callback(err);
        callback(null, stdout.trimRight());
    });
}

module.exports = {

    fileType: function(branch, workingDir, path, callback) {
        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            getFileType.bind(null, branch, workingDir, path)
        ], callback);
    },

    readDir: function(branch, workingDir, path, callback) {
        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            exec.bind(exec, 'git', ['ls-tree', branch + ':' + path], { cwd: workingDir }),
            function(stdout, stderr, cb) {
                cb(null, treeFromString(stdout));
            }
        ], callback);
    },

    readFile: function(branch, workingDir, path, callback) {
        // no need to check for branch... if it does not exist, this simply fails
        exec('git', ['--no-pager', 'show', branch + ':' + path], { cwd: workingDir, maxBuffer: 10000*1024, encoding: 'binary' },
        function(err, stdout, stderr) {
            if (err)
                return callback(err);
            if (!Buffer.isBuffer(stdout))
                stdout = new Buffer(stdout, 'binary');
            // Zero length buffers act funny, use a string
            if (stdout.length === 0)
                stdout = '';
            callback(null, stdout);
        });
    },

    writeFile: function(branch, workingDir, path, buffer, encoding, callback) {
        var commitInfo = { // FIXME: use real commit info
            GIT_AUTHOR_NAME: 'John Doe',
            GIT_AUTHOR_EMAIL: 'John Doe <john@me.doe>',
            GIT_COMMITTER_NAME: 'Lively ChangeSets',
            GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
        };

        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            createHashObject.bind(null, workingDir, buffer, encoding),
            getParentHashOfStash.bind(null, branch, workingDir),
            getCurrentTrees.bind(null, workingDir, path),
            injectHashObjectIntoFileInfo.bind(null, path),
            createTrees.bind(null, workingDir),
            createCommit.bind(null, workingDir, commitInfo, null),
            updateBranch.bind(null, branch, workingDir),
            function(fileInfo, callback) {
                callback(); // remove fileInfo from callback call
            }
        ], callback);
    },

    mkDir: function(branch, workingDir, path, callback) {
        var commitInfo = { // FIXME: use real commit info
            GIT_AUTHOR_NAME: 'John Doe',
            GIT_AUTHOR_EMAIL: 'John Doe <john@me.doe>',
            GIT_COMMITTER_NAME: 'Lively ChangeSets',
            GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
        };

        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            getParentHashOfStash.bind(null, branch, workingDir, {}),
            getCurrentTrees.bind(null, workingDir, path),
            injectEmptyDirIntoTree.bind(null, workingDir, path),
            createTrees.bind(null, workingDir),
            createCommit.bind(null, workingDir, commitInfo, null),
            updateBranch.bind(null, branch, workingDir),
            function(fileInfo, callback) {
                callback(); // remove fileInfo from callback call
            }
        ], callback);
    },

    unlink: function(branch, workingDir, path, callback) {
        var commitInfo = { // FIXME: use real commit info
            GIT_AUTHOR_NAME: 'John Doe',
            GIT_AUTHOR_EMAIL: 'John Doe <john@me.doe>',
            GIT_COMMITTER_NAME: 'Lively ChangeSets',
            GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
        };

        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            getParentHashOfStash.bind(null, branch, workingDir, {}),
            getCurrentTrees.bind(null, workingDir, path),
            removeObjectFromTree.bind(null, path),
            createTrees.bind(null, workingDir),
            createCommit.bind(null, workingDir, commitInfo, null),
            updateBranch.bind(null, branch, workingDir),
            function(fileInfo, callback) {
                callback(); // remove fileInfo from callback call
            }
        ], callback);
    },

    copy: function(branch, workingDir, source, destination, callback) {
        var commitInfo = { // FIXME: use real commit info
            GIT_AUTHOR_NAME: 'John Doe',
            GIT_AUTHOR_EMAIL: 'John Doe <john@me.doe>',
            GIT_COMMITTER_NAME: 'Lively ChangeSets',
            GIT_COMMITTER_EMAIL: 'unknown-user@lively-web.local'
        };

        async.waterfall([
            ensureBranch.bind(null, branch, workingDir),
            getParentHashOfStash.bind(null, branch, workingDir, {}),
            getCurrentTrees.bind(null, workingDir, source),
            copyFileHash.bind(null, source),
            getCurrentTrees.bind(null, workingDir, destination),
            injectHashObjectIntoFileInfo.bind(null, destination),
            createTrees.bind(null, workingDir),
            createCommit.bind(null, workingDir, commitInfo, null),
            updateBranch.bind(null, branch, workingDir),
            function(fileInfo, callback) {
                callback(); // remove fileInfo from callback call
            }
        ], callback);
    },

    rename: function(branch, workingDir, source, destination, callback) {
        async.waterfall([
            this.copy.bind(this, branch, workingDir, source, destination),
            this.unlink.bind(this, branch, workingDir, source),
        ], callback);
    },

    isIgnored: function(workingDir, path, callback) {
        exec('git', ['check-ignore', '-q', path], { cwd: workingDir }, function(err) {
            if (!err)
                callback(null, true);
            else if (!err.killed && err.code == 1) {
                callback(null, false);
            } else {
                if (err.code == 128 && !err.killed) // fatal error, mostly not a git repo
                    err.code = 'NONGIT';
                callback(err);
            }
        });
    },

    gitPath: function(workingDir, callback) {
        workingDir = path.resolve(process.env.PWD, workingDir);
        exec('git', ['rev-parse', '--show-cdup'], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err) {
                if ((err.code == 'ENOENT' && err.errno == 'ENOENT') ||
                    (err.code == 'ENOTDIR' && err.errno == 'ENOTDIR')) // fatal error, mostly non-existent working dir
                    err.code = 'NOTADIR';
                return callback(err);
            }
            callback(null, path.resolve(workingDir, stdout.trimRight()));
        });
    },

    lastModified: function(branch, workingDir, path, callback) {
        // no need to check for branch... if it does not exist, this simply fails
        exec('git', ['log', '-1', '--format=\'%aD\'', branch, '--', path], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err) return callback(err);
            var dateStr = stdout.trimRight();
            callback(null, dateStr != '' ? new Date(dateStr) : new Date(0));
        });
    },

    fileSize: function(branch, workingDir, path, callback) {
        // no need to check for branch... if it does not exist, this simply fails
        exec('git', ['cat-file', '-s', branch + ':' + path], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err || parseInt(stdout) == NaN) return callback(true);
            callback(null, parseInt(stdout));
        });
    },

    listBranches: function(workingDir, callback) {
        exec('git', ['branch', '--list'], { cwd: workingDir }, function(err, stdout, stderr) {
            if (err) return callback(err);
            var branches = stdout.trimRight().split('\n').map(function(branch) {
                return branch.substr(2);
            });
            callback(null, branches);
        });
    },

    removeBranch: function(branch, workingDir, callback) {
        exec('git', ['branch', '-D', branch], { cwd: workingDir }, function(err, stdout, stderr) {
            // do not care if the branch never existed
            callback();
        });
    },

    util: {

        createHashObjectFromFile: createHashObjectFromFile,
        injectHashObjectIntoTree: injectHashObjectIntoTree,
        removeObjectFromTree: removeObjectFromTree,
        getBranchesByHash: getBranchesByHash,
        getParentHash: getParentHash,
        getStashHash: getStashHash,
        getTree: getTree,
        createTrees: createTrees,
        createCommit: createCommit,
        createCommitFromDiffs: createCommitFromDiffs,
        updateBranch: updateBranch,
        listCommits: listCommits,
        diffCommits: diffCommits,
        readCommit: readCommit,
        addCommitNote: addCommitNote,
        getCommitNote: getCommitNote,
        removeCommitNote: removeCommitNote,
        findCommonBase: findCommonBase

    }

}