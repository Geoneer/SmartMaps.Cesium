/*eslint-env node*/
'use strict';

var fs = require('fs');
var path = require('path');
var os = require('os');
var child_process = require('child_process');
var crypto = require('crypto');
var zlib = require('zlib');
var readline = require('readline');
var request = require('request');

var globby = require('globby');
var gulpTap = require('gulp-tap');
var open = require('open');
var rimraf = require('rimraf');
var glslStripComments = require('glsl-strip-comments');
var mkdirp = require('mkdirp');
var mergeStream = require('merge-stream');
var streamToPromise = require('stream-to-promise');
var gulp = require('gulp');
var gulpInsert = require('gulp-insert');
var gulpZip = require('gulp-zip');
var gulpRename = require('gulp-rename');
var gulpReplace = require('gulp-replace');
var gulpJsonTransform = require('gulp-json-transform');
var Promise = require('bluebird');
var requirejs = require('requirejs');
var Karma = require('karma');
var yargs = require('yargs');
var AWS = require('aws-sdk');
var mime = require('mime');

var packageJson = require('./package.json');
var version = packageJson.version;
if (/\.0$/.test(version)) {
    version = version.substring(0, version.length - 2);
}

var karmaConfigFile = path.join(__dirname, 'Specs/karma.conf.js');
var travisDeployUrl = 'http://cesium-dev.s3-website-us-east-1.amazonaws.com/cesium/';

//Gulp doesn't seem to have a way to get the currently running tasks for setting
//per-task variables.  We use the command line argument here to detect which task is being run.
var taskName = process.argv[2];
var noDevelopmentGallery = taskName === 'release' || taskName === 'makeZipFile';
var minifyShaders = taskName === 'minify' || taskName === 'minifyRelease' || taskName === 'release' || taskName === 'makeZipFile' || taskName === 'buildApps';

var verbose = yargs.argv.verbose;

var concurrency = yargs.argv.concurrency;
if (!concurrency) {
    concurrency = os.cpus().length;
}

var sourceFiles = ['Source/**/*.js',
                   '!Source/*.js',
                   '!Source/Workers/**',
                   '!Source/ThirdParty/Workers/**',
                   '!Source/ThirdParty/google-earth-dbroot-parser.js',
                   '!Source/ThirdParty/pako_inflate.js',
                   '!Source/ThirdParty/crunch.js',
                   'Source/Workers/createTaskProcessorWorker.js'];

var buildFiles = ['Specs/**/*.js',
                  '!Specs/SpecList.js',
                  'Source/Shaders/**/*.glsl'];

var filesToClean = ['Source/Cesium.js',
                    'Build',
                    'Source/Shaders/**/*.js',
                    'Source/ThirdParty/Shaders/*.js',
                    'Specs/SpecList.js',
                    'Apps/Sandcastle/jsHintOptions.js',
                    'Apps/Sandcastle/gallery/gallery-index.js',
                    'Apps/Sandcastle/templates/bucket.css',
                    'Cesium-*.zip'];

var filesToSortRequires = ['Source/**/*.js',
                           '!Source/Shaders/**',
                           '!Source/ThirdParty/**',
                           '!Source/Workers/cesiumWorkerBootstrapper.js',
                           '!Source/copyrightHeader.js',
                           '!Source/Workers/transferTypedArrayTest.js',
                           'Apps/**/*.js',
                           '!Apps/Sandcastle/ThirdParty/**',
                           '!Apps/Sandcastle/jsHintOptions.js',
                           'Specs/**/*.js',
                           '!Specs/spec-main.js',
                           '!Specs/SpecRunner.js',
                           '!Specs/SpecList.js',
                           '!Specs/karma.conf.js',
                           '!Apps/Sandcastle/Sandcastle-client.js',
                           '!Apps/Sandcastle/Sandcastle-header.js',
                           '!Apps/Sandcastle/Sandcastle-warn.js',
                           '!Apps/Sandcastle/gallery/gallery-index.js'];

gulp.task('build', function(done) {
    mkdirp.sync('Build');
    glslToJavaScript(minifyShaders, 'Build/minifyShaders.state');
    createCesiumJs();
    createSpecList();
    createJsHintOptions();
    createGalleryList(done);
});

gulp.task('build-watch', function() {
    return gulp.watch(buildFiles, gulp.series('build'));
});

gulp.task('buildApps', function() {
    return Promise.join(
        buildCesiumViewer(),
        buildSandcastle()
    );
});

gulp.task('clean', function(done) {
    filesToClean.forEach(function(file) {
        rimraf.sync(file);
    });
    done();
});

gulp.task('requirejs', function(done) {
    var config = JSON.parse(Buffer.from(process.argv[3].substring(2), 'base64').toString('utf8'));

    // Disable module load timeout
    config.waitSeconds = 0;

    requirejs.optimize(config, function() {
        done();
    }, done);
});

// optimizeApproximateTerrainHeights can be used to regenerate the approximateTerrainHeights
// file from an overly precise terrain heights file to reduce bandwidth
// the approximate terrain heights are only used when the terrain provider does not have this
// information and not a high level of precision is required
gulp.task('optimizeApproximateTerrainHeights', function() {
    var argv = yargs.usage('Usage: optimizeApproximateTerrainHeights -p [degree of precision]').argv;
    var precision = typeof argv.p !== undefined ? argv.p : 1;
    precision = Math.pow(10, precision);
    return gulp.src('Source/Assets/approximateTerrainHeightsPrecise.json')
        .pipe(gulpJsonTransform(function(data, file) {
            Object.entries(data).forEach(function(entry) {
                var values = entry[1];
                data[entry[0]] = [Math.floor(values[0] * precision) / precision,
                                  Math.ceil(values[1] * precision) / precision ];
            });
            return data;
        }))
        .pipe(gulpRename('approximateTerrainHeights.json'))
        .pipe(gulp.dest('Source/Assets/'));
});

function cloc() {
    var cmdLine;
    var clocPath = path.join('node_modules', 'cloc', 'lib', 'cloc');

    //Run cloc on primary Source files only
    var source = new Promise(function(resolve, reject) {
        cmdLine = 'perl ' + clocPath + ' --quiet --progress-rate=0' +
                  ' Source/ --exclude-dir=Assets,ThirdParty --not-match-f=copyrightHeader.js';

        child_process.exec(cmdLine, function(error, stdout, stderr) {
            if (error) {
                console.log(stderr);
                return reject(error);
            }
            console.log('Source:');
            console.log(stdout);
            resolve();
        });
    });

    //If running cloc on source succeeded, also run it on the tests.
    return source.then(function() {
        return new Promise(function(resolve, reject) {
            cmdLine = 'perl ' + clocPath + ' --quiet --progress-rate=0' +
                      ' Specs/ --exclude-dir=Data';
            child_process.exec(cmdLine, function(error, stdout, stderr) {
                if (error) {
                    console.log(stderr);
                    return reject(error);
                }
                console.log('Specs:');
                console.log(stdout);
                resolve();
            });
        });
    });
}

gulp.task('cloc', gulp.series('clean', cloc));

function generateStubs(done) {
    mkdirp.sync(path.join('Build', 'Stubs'));

    var contents = '\
/*global define,Cesium*/\n\
(function() {\n\
\'use strict\';\n';
    var modulePathMappings = [];

    globby.sync(sourceFiles).forEach(function(file) {
        file = path.relative('Source', file);
        var moduleId = filePathToModuleId(file);

        contents += '\
define(\'' + moduleId + '\', function() {\n\
    return Cesium[\'' + path.basename(file, path.extname(file)) + '\'];\n\
});\n\n';

        modulePathMappings.push('        \'' + moduleId + '\' : \'../Stubs/Cesium\'');
    });

    contents += '})();\n';

    var paths = '\
define(function() {\n\
    \'use strict\';\n\
    return {\n' + modulePathMappings.join(',\n') + '\n\
    };\n\
});';

    fs.writeFileSync(path.join('Build', 'Stubs', 'Cesium.js'), contents);
    fs.writeFileSync(path.join('Build', 'Stubs', 'paths.js'), paths);
    done();
}

gulp.task('generateStubs', gulp.series('build', generateStubs));

function combine() {
    var outputDirectory = path.join('Build', 'CesiumUnminified');
    return combineJavaScript({
        removePragmas: false,
        optimizer: 'none',
        outputDirectory: outputDirectory
    });
}

gulp.task('combine', gulp.series('generateStubs', combine));
gulp.task('default', gulp.series('combine'));

function combineRelease() {
    var outputDirectory = path.join('Build', 'CesiumUnminified');
    return combineJavaScript({
        removePragmas: true,
        optimizer: 'none',
        outputDirectory: outputDirectory
    });
}

gulp.task('combineRelease', gulp.series('generateStubs', combineRelease));

//Builds the documentation
function generateDocumentation() {
    var envPathSeperator = os.platform() === 'win32' ? ';' : ':';

    return new Promise(function(resolve, reject) {
        child_process.exec('jsdoc --configure Tools/jsdoc/conf.json', {
            env : {
                PATH : process.env.PATH + envPathSeperator + 'node_modules/.bin',
                CESIUM_VERSION : version
            }
        }, function(error, stdout, stderr) {
            if (error) {
                console.log(stderr);
                return reject(error);
            }
            console.log(stdout);
            var stream = gulp.src('Documentation/Images/**').pipe(gulp.dest('Build/Documentation/Images'));
            return streamToPromise(stream).then(resolve);
        });
    });
}
gulp.task('generateDocumentation', generateDocumentation);

gulp.task('generateDocumentation-watch', function() {
    return generateDocumentation().done(function() {
        console.log('Listening for changes in documentation...');
        return gulp.watch(sourceFiles, gulp.series('generateDocumentation'));
    });
});

gulp.task('release', gulp.series('generateStubs', combine, minifyRelease, generateDocumentation));

gulp.task('makeZipFile', gulp.series('release', function() {
    //For now we regenerate the JS glsl to force it to be unminified in the release zip
    //See https://github.com/AnalyticalGraphicsInc/cesium/pull/3106#discussion_r42793558 for discussion.
    glslToJavaScript(false, 'Build/minifyShaders.state');

    var builtSrc = gulp.src([
        'Build/Apps/**',
        'Build/Cesium/**',
        'Build/CesiumUnminified/**',
        'Build/Documentation/**'
    ], {
        base : '.'
    });

    var staticSrc = gulp.src([
        'Apps/**',
        '!Apps/Sandcastle/gallery/development/**',
        'Source/**',
        'Specs/**',
        'ThirdParty/**',
        'favicon.ico',
        'gulpfile.js',
        'server.js',
        'package.json',
        'LICENSE.md',
        'CHANGES.md',
        'README.md',
        'web.config'
    ], {
        base : '.'
    });

    var indexSrc = gulp.src('index.release.html').pipe(gulpRename('index.html'));

    return mergeStream(builtSrc, staticSrc, indexSrc)
        .pipe(gulpTap(function(file) {
            // Work around an issue with gulp-zip where archives generated on Windows do
            // not properly have their directory executable mode set.
            // see https://github.com/sindresorhus/gulp-zip/issues/64#issuecomment-205324031
            if (file.isDirectory()) {
                file.stat.mode = parseInt('40777', 8);
            }
        }))
        .pipe(gulpZip('Cesium-' + version + '.zip'))
        .pipe(gulp.dest('.'));
}));

gulp.task('minify', gulp.series('generateStubs', function() {
    return combineJavaScript({
        removePragmas : false,
        optimizer : 'uglify2',
        outputDirectory : path.join('Build', 'Cesium')
    });
}));

function minifyRelease() {
    return combineJavaScript({
        removePragmas: true,
        optimizer: 'uglify2',
        //outputDirectory: path.join('Build', 'Cesium')
        outputDirectory: path.join('d:/repos/SmartMaps.UI', 'Cesium')
    });
}

gulp.task('minifyRelease', gulp.series('generateStubs', minifyRelease));

function isTravisPullRequest() {
    return process.env.TRAVIS_PULL_REQUEST !== undefined && process.env.TRAVIS_PULL_REQUEST !== 'false';
}

gulp.task('deploy-s3', function(done) {
    if (isTravisPullRequest()) {
        console.log('Skipping deployment for non-pull request.');
        done();
        return;
    }

    var argv = yargs.usage('Usage: deploy-s3 -b [Bucket Name] -d [Upload Directory]')
        .demand(['b', 'd']).argv;

    var uploadDirectory = argv.d;
    var bucketName = argv.b;
    var cacheControl = argv.c ? argv.c : 'max-age=3600';

    if (argv.confirm) {
        // skip prompt for travis
        deployCesium(bucketName, uploadDirectory, cacheControl, done);
        return;
    }

    var iface = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    // prompt for confirmation
    iface.question('Files from your computer will be published to the ' + bucketName + ' bucket. Continue? [y/n] ', function(answer) {
        iface.close();
        if (answer === 'y') {
            deployCesium(bucketName, uploadDirectory, cacheControl, done);
        } else {
            console.log('Deploy aborted by user.');
            done();
        }
    });

});

// Deploy cesium to s3
function deployCesium(bucketName, uploadDirectory, cacheControl, done) {
    var readFile = Promise.promisify(fs.readFile);
    var gzip = Promise.promisify(zlib.gzip);
    var concurrencyLimit = 2000;

    var s3 = new AWS.S3({
        maxRetries : 10,
        retryDelayOptions : {
            base : 500
        }
    });

    var existingBlobs = [];
    var totalFiles = 0;
    var uploaded = 0;
    var skipped = 0;
    var errors = [];

    var prefix = uploadDirectory + '/';
    return listAll(s3, bucketName, prefix, existingBlobs)
        .then(function() {
            return globby([
                'Apps/**',
                'Build/**',
                'Source/**',
                'Specs/**',
                'ThirdParty/**',
                '*.md',
                'favicon.ico',
                'gulpfile.js',
                'index.html',
                'package.json',
                'server.js',
                'web.config',
                '*.zip',
                '*.tgz'
            ], {
                dot : true // include hidden files
            });
        }).then(function(files) {
            return Promise.map(files, function(file) {
                var blobName = uploadDirectory + '/' + file;
                var mimeLookup = getMimeType(blobName);
                var contentType = mimeLookup.type;
                var compress = mimeLookup.compress;
                var contentEncoding = compress ? 'gzip' : undefined;
                var etag;

                totalFiles++;

                return readFile(file)
                .then(function(content) {
                    if (!compress) {
                        return content;
                    }

                    var alreadyCompressed = (content[0] === 0x1f) && (content[1] === 0x8b);
                    if (alreadyCompressed) {
                        console.log('Skipping compressing already compressed file: ' + file);
                        return content;
                    }

                    return gzip(content);
                })
                .then(function(content) {
                    // compute hash and etag
                    var hash = crypto.createHash('md5').update(content).digest('hex');
                    etag = crypto.createHash('md5').update(content).digest('base64');

                    var index = existingBlobs.indexOf(blobName);
                    if (index <= -1) {
                        return content;
                    }

                    // remove files as we find them on disk
                    existingBlobs.splice(index, 1);

                    // get file info
                    return s3.headObject({
                            Bucket: bucketName,
                            Key: blobName
                        }).promise().then(function(data) {
                            if (data.ETag !== ('"' + hash + '"') ||
                                data.CacheControl !== cacheControl ||
                                data.ContentType !== contentType ||
                                data.ContentEncoding !== contentEncoding) {
                                return content;
                            }

                            // We don't need to upload this file again
                            skipped++;
                            return undefined;
                        })
                        .catch(function(error) {
                            errors.push(error);
                        });
                })
                .then(function(content) {
                    if (!content) {
                        return;
                    }

                    if (verbose) {
                        console.log('Uploading ' + blobName + '...');
                    }
                    var params = {
                        Bucket : bucketName,
                        Key : blobName,
                        Body : content,
                        ContentMD5 : etag,
                        ContentType : contentType,
                        ContentEncoding : contentEncoding,
                        CacheControl : cacheControl
                    };

                    return s3.putObject(params).promise()
                        .then(function() {
                            uploaded++;
                        })
                        .catch(function(error) {
                            errors.push(error);
                        });
                });
            }, {concurrency : concurrencyLimit});
        }).then(function() {
            console.log('Skipped ' + skipped + ' files and successfully uploaded ' + uploaded + ' files of ' + (totalFiles - skipped) + ' files.');
            if (existingBlobs.length === 0) {
                return;
            }

            var objectsToDelete = [];
            existingBlobs.forEach(function(file) {
                //Don't delete generate zip files.
                if (!/\.(zip|tgz)$/.test(file)) {
                    objectsToDelete.push({Key : file});
                }
            });

            if (objectsToDelete.length > 0) {
                console.log('Cleaning ' + objectsToDelete.length + ' files...');

                // If more than 1000 files, we must issue multiple requests
                var batches = [];
                while (objectsToDelete.length > 1000) {
                    batches.push(objectsToDelete.splice(0, 1000));
                }
                batches.push(objectsToDelete);

                return Promise.map(batches, function(objects) {
                    return s3.deleteObjects({
                        Bucket: bucketName,
                        Delete: {
                            Objects: objects
                        }
                    }).promise().then(function() {
                        if (verbose) {
                            console.log('Cleaned ' + objects.length + ' files.');
                        }
                    });
                }, {concurrency : concurrency});
            }
        }).catch(function(error) {
            errors.push(error);
        }).then(function() {
            if (errors.length === 0) {
                done();
                return;
            }

            console.log('Errors: ');
            errors.map(function(e) {
                console.log(e);
            });
            done(1);
        });
}

function getMimeType(filename) {
    var mimeType = mime.getType(filename);
    if (mimeType) {
        //Compress everything except zipfiles, binary images, and video
        var compress = !/^(image\/|video\/|application\/zip|application\/gzip)/i.test(mimeType);
        if (mimeType === 'image/svg+xml') {
            compress = true;
        }
        return { type: mimeType, compress: compress };
    }

    //Non-standard mime types not handled by mime
    if (/\.(glsl|LICENSE|config|state)$/i.test(filename)) {
        return { type: 'text/plain', compress: true };
    } else if (/\.(czml|topojson)$/i.test(filename)) {
        return { type: 'application/json', compress: true };
    } else if (/\.(crn|tgz)$/i.test(filename)) {
        return { type: 'application/octet-stream', compress: false };
    }

    // Handle dotfiles, such as .jshintrc
    var baseName = path.basename(filename);
    if (baseName[0] === '.' || baseName.indexOf('.') === -1) {
        return { type: 'text/plain', compress: true };
    }

    // Everything else can be octet-stream compressed but print a warning
    // if we introduce a type we aren't specifically handling.
    if (!/\.(terrain|b3dm|geom|pnts|vctr|cmpt|i3dm|metadata)$/i.test(filename)) {
        console.log('Unknown mime type for ' + filename);
    }

    return { type: 'application/octet-stream', compress: true };
}

// get all files currently in bucket asynchronously
function listAll(s3, bucketName, prefix, files, marker) {
    return s3.listObjects({
        Bucket: bucketName,
        MaxKeys: 1000,
        Prefix: prefix,
        Marker: marker
    }).promise().then(function(data) {
        var items = data.Contents;
        for (var i = 0; i < items.length; i++) {
            files.push(items[i].Key);
        }

        if (data.IsTruncated) {
            // get next page of results
            return listAll(s3, bucketName, prefix, files, files[files.length - 1]);
        }
    });
}

gulp.task('deploy-set-version', function(done) {
    var buildVersion = yargs.argv.buildVersion;
    if (buildVersion) {
        // NPM versions can only contain alphanumeric and hyphen characters
        packageJson.version += '-' + buildVersion.replace(/[^[0-9A-Za-z-]/g, '');
        fs.writeFileSync('package.json', JSON.stringify(packageJson, undefined, 2));
    }
    done();
});

gulp.task('deploy-status', function() {
    if (isTravisPullRequest()) {
        console.log('Skipping deployment status for non-pull request.');
        return Promise.resolve();
    }

    var status = yargs.argv.status;
    var message = yargs.argv.message;

    var deployUrl = travisDeployUrl + process.env.TRAVIS_BRANCH + '/';
    var zipUrl = deployUrl + 'Cesium-' + packageJson.version + '.zip';
    var npmUrl = deployUrl + 'cesium-' + packageJson.version + '.tgz';
    var coverageUrl = travisDeployUrl + process.env.TRAVIS_BRANCH + '/Build/Coverage/index.html';

    return Promise.join(
        setStatus(status, deployUrl, message, 'deployment'),
        setStatus(status, zipUrl, message, 'zip file'),
        setStatus(status, npmUrl, message, 'npm package'),
        setStatus(status, coverageUrl, message, 'coverage results')
    );
});

function setStatus(state, targetUrl, description, context) {
    // skip if the environment does not have the token
    if (!process.env.TOKEN) {
        return;
    }

    var requestPost = Promise.promisify(request.post);
    return requestPost({
         url: 'https://api.github.com/repos/' + process.env.TRAVIS_REPO_SLUG + '/statuses/' + process.env.TRAVIS_COMMIT,
         json: true,
         headers: {
             'Authorization': 'token ' + process.env.TOKEN,
             'User-Agent': 'Cesium'
         },
         body: {
             state: state,
             target_url: targetUrl,
             description: description,
             context: context
         }
     });
}

gulp.task('coverage', function(done) {
    var argv = yargs.argv;
    var webglStub = argv.webglStub ? argv.webglStub : false;
    var suppressPassed = argv.suppressPassed ? argv.suppressPassed : false;
    var failTaskOnError = argv.failTaskOnError ? argv.failTaskOnError : false;

    var folders = [];
    var browsers = ['Chrome'];
    if (argv.browsers) {
        browsers = argv.browsers.split(',');
    }

    var karma = new Karma.Server({
        configFile: karmaConfigFile,
        browsers: browsers,
        specReporter: {
            suppressErrorSummary: false,
            suppressFailed: false,
            suppressPassed: suppressPassed,
            suppressSkipped: true
        },
        preprocessors: {
            'Source/Core/**/*.js': ['coverage'],
            'Source/DataSources/**/*.js': ['coverage'],
            'Source/Renderer/**/*.js': ['coverage'],
            'Source/Scene/**/*.js': ['coverage'],
            'Source/Shaders/**/*.js': ['coverage'],
            'Source/Widgets/**/*.js': ['coverage'],
            'Source/Workers/**/*.js': ['coverage']
        },
        reporters: ['spec', 'coverage'],
        coverageReporter: {
            dir: 'Build/Coverage',
            subdir: function(browserName) {
                folders.push(browserName);
                return browserName;
            },
            includeAllSources: true
        },
        client: {
            captureConsole: verbose,
            args: [undefined, undefined, undefined, webglStub, undefined]
        }
    }, function(e) {
        var html = '<!doctype html><html><body><ul>';
        folders.forEach(function(folder) {
            html += '<li><a href="' + encodeURIComponent(folder) + '/index.html">' + folder + '</a></li>';
        });
        html += '</ul></body></html>';
        fs.writeFileSync('Build/Coverage/index.html', html);

        if (!process.env.TRAVIS) {
            folders.forEach(function(dir) {
                open('Build/Coverage/' + dir + '/index.html');
            });
        }
        return done(failTaskOnError ? e : undefined);
    });
    karma.start();
});

gulp.task('test', function(done) {
    var argv = yargs.argv;

    var enableAllBrowsers = argv.all ? true : false;
    var includeCategory = argv.include ? argv.include : '';
    var excludeCategory = argv.exclude ? argv.exclude : '';
    var webglValidation = argv.webglValidation ? argv.webglValidation : false;
    var webglStub = argv.webglStub ? argv.webglStub : false;
    var release = argv.release ? argv.release : false;
    var failTaskOnError = argv.failTaskOnError ? argv.failTaskOnError : false;
    var suppressPassed = argv.suppressPassed ? argv.suppressPassed : false;

    var browsers = ['Chrome'];
    if (argv.browsers) {
        browsers = argv.browsers.split(',');
    }

    var files = [
        'Specs/karma-main.js',
        {pattern : 'Source/**', included : false},
        {pattern : 'Specs/**', included : false}
    ];

    if (release) {
        files.push({pattern : 'Build/**', included : false});
    }

    var karma = new Karma.Server({
        configFile: karmaConfigFile,
        browsers: browsers,
        specReporter: {
            suppressErrorSummary: false,
            suppressFailed: false,
            suppressPassed: suppressPassed,
            suppressSkipped: true
        },
        detectBrowsers: {
            enabled: enableAllBrowsers
        },
        logLevel: verbose ? Karma.constants.LOG_INFO : Karma.constants.LOG_ERROR,
        files: files,
        client: {
            captureConsole: verbose,
            args: [includeCategory, excludeCategory, webglValidation, webglStub, release]
        }
    }, function(e) {
        return done(failTaskOnError ? e : undefined);
    });
    karma.start();
});

gulp.task('sortRequires', function() {
    var noModulesRegex = /[\s\S]*?define\(function\(\)/;
    var requiresRegex = /([\s\S]*?(define|require)\((?:{[\s\S]*}, )?\[)([\S\s]*?)]([\s\S]*?function\s*)\(([\S\s]*?)\) {([\s\S]*)/;
    var splitRegex = /,\s*/;

    var fsReadFile = Promise.promisify(fs.readFile);
    var fsWriteFile = Promise.promisify(fs.writeFile);

    var files = globby.sync(filesToSortRequires);
    return Promise.map(files, function(file) {

        return fsReadFile(file).then(function(contents) {

            var result = requiresRegex.exec(contents);

            if (result === null) {
                if (!noModulesRegex.test(contents)) {
                    console.log(file + ' does not have the expected syntax.');
                }
                return;
            }

            var names = result[3].split(splitRegex);
            if (names.length === 1 && names[0].trim() === '') {
                names.length = 0;
            }

            var i;
            for (i = 0; i < names.length; ++i) {
                if (names[i].indexOf('//') >= 0 || names[i].indexOf('/*') >= 0) {
                    console.log(file + ' contains comments in the require list.  Skipping so nothing gets broken.');
                    return;
                }
            }

            var identifiers = result[5].split(splitRegex);
            if (identifiers.length === 1 && identifiers[0].trim() === '') {
                identifiers.length = 0;
            }

            for (i = 0; i < identifiers.length; ++i) {
                if (identifiers[i].indexOf('//') >= 0 || identifiers[i].indexOf('/*') >= 0) {
                    console.log(file + ' contains comments in the require list.  Skipping so nothing gets broken.');
                    return;
                }
            }

            var requires = [];

            for (i = 0; i < names.length && i < identifiers.length; ++i) {
                requires.push({
                    name : names[i].trim(),
                    identifier : identifiers[i].trim()
                });
            }

            requires.sort(function(a, b) {
                var aName = a.name.toLowerCase();
                var bName = b.name.toLowerCase();
                if (aName < bName) {
                    return -1;
                } else if (aName > bName) {
                    return 1;
                }
                return 0;
            });

            // Convert back to separate lists for the names and identifiers, and add
            // any additional names or identifiers that don't have a corresponding pair.
            var sortedNames = requires.map(function(item) {
                return item.name;
            });
            for (i = sortedNames.length; i < names.length; ++i) {
                sortedNames.push(names[i].trim());
            }

            var sortedIdentifiers = requires.map(function(item) {
                return item.identifier;
            });
            for (i = sortedIdentifiers.length; i < identifiers.length; ++i) {
                sortedIdentifiers.push(identifiers[i].trim());
            }

            var outputNames = ']';
            if (sortedNames.length > 0) {
                outputNames = os.EOL + '        ' +
                              sortedNames.join(',' + os.EOL + '        ') +
                              os.EOL + '    ]';
            }

            var outputIdentifiers = '(';
            if (sortedIdentifiers.length > 0) {
                outputIdentifiers = '(' + os.EOL + '        ' +
                                    sortedIdentifiers.join(',' + os.EOL + '        ');
            }

            contents = result[1] +
                       outputNames +
                       result[4].replace(/^[,\s]+/, ', ').trim() +
                       outputIdentifiers +
                       ') {' +
                       result[6];

            return fsWriteFile(file, contents);
        });
    });
});

function combineCesium(debug, optimizer, combineOutput) {
    return requirejsOptimize('Cesium.js', {
        wrap : true,
        useStrict : true,
        optimize : optimizer,
        optimizeCss : 'standard',
        pragmas : {
            debug : debug
        },
        baseUrl : 'Source',
        skipModuleInsertion : true,
        name : removeExtension(path.relative('Source', require.resolve('almond'))),
        include : 'main',
        out : path.join(combineOutput, 'Cesium.js')
    });
}

function combineWorkers(debug, optimizer, combineOutput) {
    //This is done waterfall style for concurrency reasons.
    // Copy files that are already minified
    return globby(['Source/ThirdParty/Workers/draco*.js'])
        .then(function(files) {
            var stream = gulp.src(files, { base: 'Source' })
                .pipe(gulp.dest(combineOutput));
            return streamToPromise(stream);
        })
        .then(function () {
            return globby(['Source/Workers/cesiumWorkerBootstrapper.js',
                'Source/Workers/transferTypedArrayTest.js',
                'Source/ThirdParty/Workers/*.js',
                // Files are already minified, don't optimize
                '!Source/ThirdParty/Workers/draco*.js']);
        })
        .then(function(files) {
            return Promise.map(files, function(file) {
                return requirejsOptimize(file, {
                    wrap : false,
                    useStrict : true,
                    optimize : optimizer,
                    optimizeCss : 'standard',
                    pragmas : {
                        debug : debug
                    },
                    baseUrl : 'Source',
                    skipModuleInsertion : true,
                    include : filePathToModuleId(path.relative('Source', file)),
                    out : path.join(combineOutput, path.relative('Source', file))
                });
            }, {concurrency : concurrency});
        })
        .then(function() {
            return globby(['Source/Workers/*.js',
                           '!Source/Workers/cesiumWorkerBootstrapper.js',
                           '!Source/Workers/transferTypedArrayTest.js',
                           '!Source/Workers/createTaskProcessorWorker.js',
                           '!Source/ThirdParty/Workers/*.js']);
        })
        .then(function(files) {
            return Promise.map(files, function(file) {
                return requirejsOptimize(file, {
                    wrap : true,
                    useStrict : true,
                    optimize : optimizer,
                    optimizeCss : 'standard',
                    pragmas : {
                        debug : debug
                    },
                    baseUrl : 'Source',
                    include : filePathToModuleId(path.relative('Source', file)),
                    out : path.join(combineOutput, path.relative('Source', file))
                });
            }, {concurrency : concurrency});
        });
}

function minifyCSS(outputDirectory) {
    return globby('Source/**/*.css').then(function(files) {
        return Promise.map(files, function(file) {
            return requirejsOptimize(file, {
                wrap : true,
                useStrict : true,
                optimizeCss : 'standard',
                pragmas : {
                    debug : true
                },
                cssIn : file,
                out : path.join(outputDirectory, path.relative('Source', file))
            });
        }, {concurrency : concurrency});
    });
}

var gulpUglify = require('gulp-uglify');

function minifyModules(outputDirectory) {
    return streamToPromise(gulp.src('Source/ThirdParty/google-earth-dbroot-parser.js')
        .pipe(gulpUglify())
        .pipe(gulp.dest(outputDirectory + '/ThirdParty/')));
}

function combineJavaScript(options) {
    var optimizer = options.optimizer;
    var outputDirectory = options.outputDirectory;
    var removePragmas = options.removePragmas;

    var combineOutput = path.join('Build', 'combineOutput', optimizer);
    var copyrightHeader = fs.readFileSync(path.join('Source', 'copyrightHeader.js'));

    var promise = Promise.join(
        combineCesium(!removePragmas, optimizer, combineOutput),
        combineWorkers(!removePragmas, optimizer, combineOutput),
        minifyModules(outputDirectory)
    );

    return promise.then(function() {
        var promises = [];

        //copy to build folder with copyright header added at the top
        var stream = gulp.src([combineOutput + '/**'])
            .pipe(gulpInsert.prepend(copyrightHeader))
            .pipe(gulp.dest(outputDirectory));

        promises.push(streamToPromise(stream));

        var everythingElse = ['Source/**', '!**/*.js', '!**/*.glsl'];

        if (optimizer === 'uglify2') {
            promises.push(minifyCSS(outputDirectory));
            everythingElse.push('!**/*.css');
        }

        stream = gulp.src(everythingElse, { nodir: true }).pipe(gulp.dest(outputDirectory));
        promises.push(streamToPromise(stream));

        return Promise.all(promises).then(function() {
            rimraf.sync(combineOutput);
        });
    });
}

function glslToJavaScript(minify, minifyStateFilePath) {
    fs.writeFileSync(minifyStateFilePath, minify);
    var minifyStateFileLastModified = fs.existsSync(minifyStateFilePath) ? fs.statSync(minifyStateFilePath).mtime.getTime() : 0;

// collect all currently existing JS files into a set, later we will remove the ones
// we still are using from the set, then delete any files remaining in the set.
    var leftOverJsFiles = {};

    globby.sync(['Source/Shaders/**/*.js', 'Source/ThirdParty/Shaders/*.js']).forEach(function(file) {
        leftOverJsFiles[path.normalize(file)] = true;
    });

    var builtinFunctions = [];
    var builtinConstants = [];
    var builtinStructs = [];

    var glslFiles = globby.sync(['Source/Shaders/**/*.glsl', 'Source/ThirdParty/Shaders/*.glsl']);
    glslFiles.forEach(function(glslFile) {
        glslFile = path.normalize(glslFile);
        var baseName = path.basename(glslFile, '.glsl');
        var jsFile = path.join(path.dirname(glslFile), baseName) + '.js';

        // identify built in functions, structs, and constants
        var baseDir = path.join('Source', 'Shaders', 'Builtin');
        if (glslFile.indexOf(path.normalize(path.join(baseDir, 'Functions'))) === 0) {
            builtinFunctions.push(baseName);
        }
        else if (glslFile.indexOf(path.normalize(path.join(baseDir, 'Constants'))) === 0) {
            builtinConstants.push(baseName);
        }
        else if (glslFile.indexOf(path.normalize(path.join(baseDir, 'Structs'))) === 0) {
            builtinStructs.push(baseName);
        }

        delete leftOverJsFiles[jsFile];

        var jsFileExists = fs.existsSync(jsFile);
        var jsFileModified = jsFileExists ? fs.statSync(jsFile).mtime.getTime() : 0;
        var glslFileModified = fs.statSync(glslFile).mtime.getTime();

        if (jsFileExists && jsFileModified > glslFileModified && jsFileModified > minifyStateFileLastModified) {
            return;
        }

        var contents = fs.readFileSync(glslFile, 'utf8');
        contents = contents.replace(/\r\n/gm, '\n');

        var copyrightComments = '';
        var extractedCopyrightComments = contents.match(/\/\*\*(?:[^*\/]|\*(?!\/)|\n)*?@license(?:.|\n)*?\*\//gm);
        if (extractedCopyrightComments) {
            copyrightComments = extractedCopyrightComments.join('\n') + '\n';
        }

        if (minify) {
            contents = glslStripComments(contents);
            contents = contents.replace(/\s+$/gm, '').replace(/^\s+/gm, '').replace(/\n+/gm, '\n');
            contents += '\n';
        }

        contents = contents.split('"').join('\\"').replace(/\n/gm, '\\n\\\n');
        contents = copyrightComments + '\
//This file is automatically rebuilt by the Cesium build process.\n\
define(function() {\n\
    \'use strict\';\n\
    return "' + contents + '";\n\
});';

        fs.writeFileSync(jsFile, contents);
    });

    // delete any left over JS files from old shaders
    Object.keys(leftOverJsFiles).forEach(function(filepath) {
        rimraf.sync(filepath);
    });

    var generateBuiltinContents = function(contents, builtins, path) {
        var amdPath = contents.amdPath;
        var amdClassName = contents.amdClassName;
        var builtinLookup = contents.builtinLookup;
        for (var i = 0; i < builtins.length; i++) {
            var builtin = builtins[i];
            amdPath = amdPath + ',\n        \'./' + path + '/' + builtin + '\'';
            amdClassName = amdClassName + ',\n        ' + 'czm_' + builtin;
            builtinLookup = builtinLookup + ',\n        ' + 'czm_' + builtin + ' : ' + 'czm_' + builtin;
        }
        contents.amdPath = amdPath;
        contents.amdClassName = amdClassName;
        contents.builtinLookup = builtinLookup;
    };

//generate the JS file for Built-in GLSL Functions, Structs, and Constants
    var contents = {amdPath : '', amdClassName : '', builtinLookup : ''};
    generateBuiltinContents(contents, builtinConstants, 'Constants');
    generateBuiltinContents(contents, builtinStructs, 'Structs');
    generateBuiltinContents(contents, builtinFunctions, 'Functions');

    contents.amdPath = contents.amdPath.replace(',\n', '');
    contents.amdClassName = contents.amdClassName.replace(',\n', '');
    contents.builtinLookup = contents.builtinLookup.replace(',\n', '');

    var fileContents = '\
//This file is automatically rebuilt by the Cesium build process.\n\
define([\n' +
                       contents.amdPath +
                       '\n    ], function(\n' +
                       contents.amdClassName +
                       ') {\n\
                           \'use strict\';\n\
                           return {\n' + contents.builtinLookup + '};\n\
});';

    fs.writeFileSync(path.join('Source', 'Shaders', 'Builtin', 'CzmBuiltins.js'), fileContents);
}

function createCesiumJs() {
    var moduleIds = [];
    var parameters = [];
    var assignments = [];

    var nonIdentifierRegexp = /[^0-9a-zA-Z_$]/g;

    globby.sync(sourceFiles).forEach(function(file) {
        file = path.relative('Source', file);
        var moduleId = file;
        moduleId = filePathToModuleId(moduleId);

        var assignmentName = "['" + path.basename(file, path.extname(file)) + "']";
        if (moduleId.indexOf('Shaders/') === 0) {
            assignmentName = '._shaders' + assignmentName;
        }

        var parameterName = moduleId.replace(nonIdentifierRegexp, '_');

        moduleIds.push("'./" + moduleId + "'");
        parameters.push(parameterName);
        assignments.push('Cesium' + assignmentName + ' = ' + parameterName + ';');
    });

    var contents = '\
define([' + moduleIds.join(', ') + '], function(' + parameters.join(', ') + ') {\n\
  \'use strict\';\n\
  var Cesium = {\n\
    VERSION : \'' + version + '\',\n\
    _shaders : {}\n\
  };\n\
  ' + assignments.join('\n  ') + '\n\
  return Cesium;\n\
});\n';

    fs.writeFileSync('Source/Cesium.js', contents);
}

function createSpecList() {
    var specFiles = globby.sync(['Specs/**/*.js', '!Specs/*.js']);
    var specs = [];

    specFiles.forEach(function(file) {
        specs.push("'" + filePathToModuleId(file) + "'");
    });

    var contents = '/*eslint-disable no-unused-vars*/\n/*eslint-disable no-implicit-globals*/\nvar specs = [' + specs.join(',') + '];\n';
    fs.writeFileSync(path.join('Specs', 'SpecList.js'), contents);
}

function createGalleryList(done) {
    var demoObjects = [];
    var demoJSONs = [];
    var output = path.join('Apps', 'Sandcastle', 'gallery', 'gallery-index.js');

    var fileList = ['Apps/Sandcastle/gallery/**/*.html'];
    if (noDevelopmentGallery) {
        fileList.push('!Apps/Sandcastle/gallery/development/**/*.html');
    }

    // On travis, the version is set to something like '1.43.0-branch-name-travisBuildNumber'
    // We need to extract just the Major.Minor version
    var majorMinor = packageJson.version.match(/^(.*)\.(.*)\./);
    var major = majorMinor[1];
    var minor = Number(majorMinor[2]) - 1; // We want the last release, not current release
    var tagVersion = major + '.' + minor;

    // Get an array of demos that were added since the last release.
    // This includes newly staged local demos as well.
    var newDemos = [];
    try {
        newDemos = child_process.execSync('git diff --name-only --diff-filter=A ' + tagVersion + ' Apps/Sandcastle/gallery/*.html', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim().split('\n');
    } catch (e) {
        // On a Cesium fork, tags don't exist so we can't generate the list.
    }

    var helloWorld;
    globby.sync(fileList).forEach(function(file) {
        var demo = filePathToModuleId(path.relative('Apps/Sandcastle/gallery', file));

        var demoObject = {
            name : demo,
            isNew: newDemos.includes(file)
        };

        if (fs.existsSync(file.replace('.html', '') + '.jpg')) {
            demoObject.img = demo + '.jpg';
        }

        demoObjects.push(demoObject);

        if (demo === 'Hello World') {
            helloWorld = demoObject;
        }
    });

    demoObjects.sort(function(a, b) {
      if (a.name < b.name) {
        return -1;
      } else if (a.name > b.name) {
        return 1;
      }
      return 0;
    });

    var helloWorldIndex = Math.max(demoObjects.indexOf(helloWorld), 0);

    var i;
    for (i = 0; i < demoObjects.length; ++i) {
      demoJSONs[i] = JSON.stringify(demoObjects[i], null, 2);
    }

    var contents = '\
// This file is automatically rebuilt by the Cesium build process.\n\
var hello_world_index = ' + helloWorldIndex + ';\n\
var gallery_demos = [' + demoJSONs.join(', ') + '];\n\
var has_new_gallery_demos = ' + (newDemos.length > 0 ? 'true;' : 'false;') + '\n';

    fs.writeFileSync(output, contents);

    // Compile CSS for Sandcastle
    var outputFile = path.join('Apps', 'Sandcastle', 'templates', 'bucket.css');

    requirejs.optimize({
        cssIn : path.join('Apps', 'Sandcastle', 'templates', 'bucketRaw.css'),
        out : outputFile,
        waitSeconds : 0
    }, function() {
        var data = fs.readFileSync(outputFile); //read existing contents into data
        var fd = fs.openSync(outputFile, 'w+');
        var buffer = Buffer.from('/* This file is automatically rebuilt by the Cesium build process. */\n');

        fs.writeSync(fd, buffer, 0, buffer.length, 0); //write new data
        fs.writeSync(fd, data, 0, data.length, buffer.length); //append old data

        fs.close(fd);
        done();
    }, done);
}

function createJsHintOptions() {
    var primary = JSON.parse(fs.readFileSync(path.join('Apps', '.jshintrc'), 'utf8'));
    var gallery = JSON.parse(fs.readFileSync(path.join('Apps', 'Sandcastle', '.jshintrc'), 'utf8'));
    primary.jasmine = false;
    primary.predef = gallery.predef;
    primary.unused = gallery.unused;

    var contents = '\
// This file is automatically rebuilt by the Cesium build process.\n\
var sandcastleJsHintOptions = ' + JSON.stringify(primary, null, 4) + ';\n';

    fs.writeFileSync(path.join('Apps', 'Sandcastle', 'jsHintOptions.js'), contents);
}

function buildSandcastle() {
    var appStream = gulp.src([
            'Apps/Sandcastle/**',
            '!Apps/Sandcastle/standalone.html',
            '!Apps/Sandcastle/images/**',
            '!Apps/Sandcastle/gallery/**.jpg'
        ])
        // Replace require Source with pre-built Cesium
        .pipe(gulpReplace('../../../ThirdParty/requirejs-2.1.20/require.js', '../../../CesiumUnminified/Cesium.js'))
        // Use unminified cesium instead of source
        .pipe(gulpReplace('Source/Cesium', 'CesiumUnminified'))
        // Fix relative paths for new location
        .pipe(gulpReplace('../../Source', '../../../Source'))
        .pipe(gulpReplace('../../ThirdParty', '../../../ThirdParty'))
        .pipe(gulpReplace('../../SampleData', '../../../../Apps/SampleData'))
        .pipe(gulpReplace('Build/Documentation', 'Documentation'))
        .pipe(gulp.dest('Build/Apps/Sandcastle'));

    var imageStream = gulp.src([
            'Apps/Sandcastle/gallery/**.jpg',
            'Apps/Sandcastle/images/**'
        ], {
            base: 'Apps/Sandcastle',
            buffer: false
        })
        .pipe(gulp.dest('Build/Apps/Sandcastle'));

    var standaloneStream = gulp.src([
        'Apps/Sandcastle/standalone.html'
        ])
        .pipe(gulpReplace('../../ThirdParty/requirejs-2.1.20/require.js', '../../../ThirdParty/requirejs-2.1.20/require.js'))
        .pipe(gulpReplace('Source/Cesium', 'CesiumUnminified'))
        .pipe(gulp.dest('Build/Apps/Sandcastle'));

    return streamToPromise(mergeStream(appStream, imageStream, standaloneStream));
}

function buildCesiumViewer() {
    var cesiumViewerOutputDirectory = 'Build/Apps/CesiumViewer';
    var cesiumViewerStartup = path.join(cesiumViewerOutputDirectory, 'CesiumViewerStartup.js');
    var cesiumViewerCss = path.join(cesiumViewerOutputDirectory, 'CesiumViewer.css');
    mkdirp.sync(cesiumViewerOutputDirectory);

    var promise = Promise.join(
        requirejsOptimize('CesiumViewer', {
            wrap : true,
            useStrict : true,
            optimizeCss : 'standard',
            pragmas : {
                debug : false
            },
            optimize : 'uglify2',
            mainConfigFile : 'Apps/CesiumViewer/CesiumViewerStartup.js',
            name : 'CesiumViewerStartup',
            out : cesiumViewerStartup
        }),
        requirejsOptimize('CesiumViewer CSS', {
            wrap : true,
            useStrict : true,
            optimizeCss : 'standard',
            pragmas : {
                debug : false
            },
            cssIn : 'Apps/CesiumViewer/CesiumViewer.css',
            out : cesiumViewerCss
        })
    );

    promise = promise.then(function() {
        var copyrightHeader = fs.readFileSync(path.join('Source', 'copyrightHeader.js'));

        var stream = mergeStream(
            gulp.src(cesiumViewerStartup)
                .pipe(gulpInsert.prepend(copyrightHeader))
                .pipe(gulpReplace('../../Source', '.'))
                .pipe(gulpReplace('../../ThirdParty/requirejs-2.1.20', '.')),

            gulp.src(cesiumViewerCss)
                .pipe(gulpReplace('../../Source', '.')),

            gulp.src(['Apps/CesiumViewer/index.html'])
                .pipe(gulpReplace('../../ThirdParty/requirejs-2.1.20', '.')),

            gulp.src(['Apps/CesiumViewer/**',
                      '!Apps/CesiumViewer/index.html',
                      '!Apps/CesiumViewer/**/*.js',
                      '!Apps/CesiumViewer/**/*.css']),

            gulp.src(['ThirdParty/requirejs-2.1.20/require.min.js'])
                .pipe(gulpRename('require.js')),

            gulp.src(['Build/Cesium/Assets/**',
                      'Build/Cesium/Workers/**',
                      'Build/Cesium/ThirdParty/**',
                      'Build/Cesium/Widgets/**',
                      '!Build/Cesium/Widgets/**/*.css'],
                {
                    base : 'Build/Cesium',
                    nodir : true
                }),

            gulp.src(['Build/Cesium/Widgets/InfoBox/InfoBoxDescription.css'], {
                base : 'Build/Cesium'
            }),

            gulp.src(['web.config'])
        );

        return streamToPromise(stream.pipe(gulp.dest(cesiumViewerOutputDirectory)));
    });

    return promise;
}

function filePathToModuleId(moduleId) {
    return moduleId.substring(0, moduleId.lastIndexOf('.')).replace(/\\/g, '/');
}

function removeExtension(p) {
    return p.slice(0, -path.extname(p).length);
}

function requirejsOptimize(name, config) {
    if (verbose) {
        console.log('Building ' + name);
    }
    return new Promise(function(resolve, reject) {
        var cmd = 'npm run requirejs -- --' + Buffer.from(JSON.stringify(config)).toString('base64') + ' --silent';
        child_process.exec(cmd, function(e) {
            if (e) {
                console.log('Error ' + name);
                reject(e);
                return;
            }
            if (verbose) {
                console.log('Finished ' + name);
            }
            resolve();
        });
    });
}
