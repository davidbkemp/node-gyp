
module.exports = exports = build

/**
 * Module dependencies.
 */

var fs = require('graceful-fs')
  , rm = require('rimraf')
  , path = require('path')
  , glob = require('glob')
  , log = require('npmlog')
  , which = require('which')
  , mkdirp = require('mkdirp')
  , exec = require('child_process').exec
  , win = process.platform == 'win32'

exports.usage = 'Invokes `' + (win ? 'msbuild' : 'make') + '` and builds the module'

function build (gyp, argv, callback) {

  var makeCommand = gyp.opts.make || process.env.MAKE
      || (process.platform.indexOf('bsd') != -1 ? 'gmake' : 'make')
    , command = win ? 'msbuild' : makeCommand
    , buildDir = path.resolve('build')
    , configPath = path.resolve(buildDir, 'config.gypi')
    , jobs = gyp.opts.jobs || process.env.JOBS
    , buildType
    , config
    , arch
    , nodeDir
    , copyDevLib

  loadConfigGypi()

  /**
   * Load the "config.gypi" file that was generated during "configure".
   */

  function loadConfigGypi () {
    fs.readFile(configPath, 'utf8', function (err, data) {
      if (err) {
        if (err.code == 'ENOENT') {
          callback(new Error('You must run `node-gyp configure` first!'))
        } else {
          callback(err)
        }
        return
      }
      config = JSON.parse(data.replace(/\#.+\n/, ''))

      // get the 'arch', 'buildType', and 'nodeDir' vars from the config
      buildType = config.target_defaults.default_configuration
      arch = config.variables.target_arch
      nodeDir = config.variables.nodedir
      copyDevLib = config.variables.copy_dev_lib == 'true'

      if ('debug' in gyp.opts) {
        buildType = gyp.opts.debug ? 'Debug' : 'Release'
      }
      if (!buildType) {
        buildType = 'Release'
      }

      log.verbose('build type', buildType)
      log.verbose('architecture', arch)
      log.verbose('node dev dir', nodeDir)

      if (win) {
        findSolutionFile()
      } else {
        doWhich()
      }
    })
  }

  /**
   * On Windows, find the first build/*.sln file.
   */

  function findSolutionFile () {
    glob('build/*.sln', function (err, files) {
      if (err) return callback(err)
      if (files.length === 0) {
        return callback(new Error('Could not find *.sln file. Did you run "configure"?'))
      }
      guessedSolution = files[0]
      log.verbose('found first Solution file', guessedSolution)
      doWhich()
    })
  }

  /**
   * Uses node-which to locate the msbuild / make executable.
   */

  function doWhich () {
    // First make sure we have the build command in the PATH
    which(command, function (err, execPath) {
      if (err) {
        if (win && /not found/.test(err.message)) {
          // On windows and no 'msbuild' found. Let's guess where it is
          findMsbuild()
        } else {
          // Some other error or 'make' not found on Unix, report that to the user
          callback(err)
        }
        return
      }
      log.verbose('`which` succeeded for `' + command + '`', execPath)
      copyNodeLib()
    })
  }

  /**
   * Search for the location of "msbuild.exe" file on Windows.
   */

  function findMsbuild () {
    log.verbose('could not find "msbuild.exe". guessing location')
    var notfoundErr = new Error('Can\'t find "msbuild.exe". Do you have Microsoft Visual Studio C++ 2008+ installed?')
    exec('reg query HKLM\\Software\\Microsoft\\MSBuild\\ToolsVersions /s /f MSBuildToolsPath /e /t REG_SZ', function (err, stdout, stderr) {
      var reVers = /Software\\Microsoft\\MSBuild\\ToolsVersions\\([^\r]+)\r\n\s+MSBuildToolsPath\s+REG_SZ\s+([^\r]+)/gi
        , msbuilds = []
        , r
        , msbuildPath
      if (err) {
        return callback(notfoundErr)
      }
      while (r = reVers.exec(stdout)) {
        if (parseFloat(r[1], 10) >= 3.5) {
          msbuilds.push({
            version: parseFloat(r[1], 10),
            path: r[2]
          })
        }
      }
      msbuilds.sort(function (x, y) {
        return (x.version < y.version ? -1 : 1)
      })
      ;(function verifyMsbuild () {
        msbuildPath = path.resolve(msbuilds.pop().path, 'msbuild.exe')
        fs.stat(msbuildPath, function (err, stat) {
          if (err) {
            if (err.code == 'ENOENT') {
              if (msbuilds.length) {
                return verifyMsbuild()
              } else {
                callback(notfoundErr)
              }
            } else {
              callback(err)
            }
            return
          }
          command = msbuildPath
          copyNodeLib()
        })
      })()
    })
  }

  /**
   * Copies the node.lib file for the current target architecture into the
   * current proper dev dir location.
   */

  function copyNodeLib () {
    if (!win || !copyDevLib) return doBuild()

    var buildDir = path.resolve(nodeDir, buildType)
      , archNodeLibPath = path.resolve(nodeDir, arch, 'node.lib')
      , buildNodeLibPath = path.resolve(buildDir, 'node.lib')

    mkdirp(buildDir, function (err, isNew) {
      if (err) return callback(err)
      log.verbose('"' + buildType + '" dir needed to be created?', isNew)
      var rs = fs.createReadStream(archNodeLibPath)
        , ws = fs.createWriteStream(buildNodeLibPath)
      log.verbose('copying "node.lib" for ' + arch, buildNodeLibPath)
      rs.pipe(ws)
      rs.on('error', callback)
      ws.on('error', callback)
      rs.on('end', doBuild)
    })
  }

  /**
   * Actually spawn the process and compile the module.
   */

  function doBuild () {

    // Enable Verbose build
    var verbose = log.levels[log.level] <= log.levels.verbose
    if (!win && verbose) {
      argv.push('V=1')
    }
    if (win && !verbose) {
      argv.push('/clp:Verbosity=minimal')
    }

    if (win) {
      // Turn off the Microsoft logo on Windows
      argv.push('/nologo')
    }

    // Specify the build type, Release by default
    if (win) {
      var p = arch === 'x64' ? 'x64' : 'Win32'
      argv.push('/p:Configuration=' + buildType + ';Platform=' + p)
      if (jobs) {
        if (!isNaN(parseInt(jobs, 10))) {
          argv.push('/m:' + parseInt(jobs, 10))
        } else if (jobs.toUpperCase() === 'MAX') {
          argv.push('/m:' + require('os').cpus().length)
        }
      }
    } else {
      argv.push('BUILDTYPE=' + buildType)
      // Invoke the Makefile in the 'build' dir.
      argv.push('-C')
      argv.push('build')
      if (jobs) {
        if (!isNaN(parseInt(jobs, 10))) {
          argv.push('--jobs')
          argv.push(parseInt(jobs, 10))
        } else if (jobs.toUpperCase() === 'MAX') {
          argv.push('--jobs')
          argv.push(require('os').cpus().length)
        }
      }
    }

    if (win) {
      // did the user specify their own .sln file?
      var hasSln = argv.some(function (arg) {
        return path.extname(arg) == '.sln'
      })
      if (!hasSln) {
        argv.unshift(gyp.opts.solution || guessedSolution)
      }
    }

    var proc = gyp.spawn(command, argv)
    proc.on('exit', onExit)
  }

  /**
   * Invoked after the make/msbuild command exits.
   */

  function onExit (code, signal) {
    if (code !== 0) {
      return callback(new Error('`' + command + '` failed with exit code: ' + code))
    }
    if (signal) {
      return callback(new Error('`' + command + '` got signal: ' + signal))
    }
    //symlinkNodeBinding()
    callback()
  }

  function symlinkNodeBinding () {
    var source, target
    var buildDir = 'build/' + buildType + '/*.node'
    log.verbose('globbing for files', buildDir)
    glob(buildDir, function (err, nodeFiles) {
      if (err) return callback(err)
      log.silly('symlink', 'linking files', nodeFiles)
      function link () {
        var file = nodeFiles.shift()
        if (!file) {
          // no more files to link... done!
          return callback()
        }
        if (win) {
          // windows requires absolute paths for junctions
          source = path.resolve('build', path.basename(file))
          target = path.resolve(file)
        } else {
          // on unix, use only relative paths since they're nice
          source = path.join('build', path.basename(file))
          target = path.relative('build', file)
        }
        log.info('symlink', 'creating %s "%s" pointing to "%s"', win ? 'junction' : 'symlink', source, target)
        fs.symlink(target, source, 'junction', function (err) {
          if (err) {
            if (err.code === 'EEXIST') {
              log.verbose('destination already exists; deleting', dest)
              rm(dest, function (err) {
                if (err) return callback(err)
                log.verbose('delete successful; trying symlink again')
                nodeFiles.unshift(file)
                link()
              })
            } else {
              callback(err)
            }
            return
          }
          // process the next file, if any
          link()
        })
      }
      // start linking
      link()
    })
  }

}
