#!/usr/bin/env node
'use strict';

// jshint -W079
const Promise = require('bluebird');
// jshint +W079
const fs = Promise.promisifyAll(require('fs'));
const path = require('path');
const util = require('util');

const toml = require('toml');
const rimraf = Promise.promisify(require('rimraf'));
const mkdirp = Promise.promisify(require('mkdirp'));
const markdown = require('markdown').markdown;
const requirejs = require('requirejs');
const UglifyJS = require('uglify-js');
const yazl = require('yazl');

const crx = require('./crx.js');

const argv = require('yargs')
  .usage('Usage: $0 [options]')
  .string('version')
  .describe('version', 'Provide a specific version number to use.  Defaults to metadata value.')
  .alias('v', 'version')
  .boolean('debug')
  .describe('debug', 'Disable minification of the source code.')
  .string('pem')
  .describe('pem', 'Location of the PEM file.')
  .demand([ 'pem' ])
  .help('h')
  .alias('h', 'help')
  .argv;

const INVALID_VERSION_ERR = 'Invalid version in Greasemonkey metadata.  Version must be in the \
format x.x.x, where x is an integer (0 <= x <= 65535), without leading zeros';

const gettingAlmond = fs.readFileAsync(
  path.join(__dirname, 'node_modules/almond/almond.js'),
  'utf-8'
);

// { name: 'Autopilot++', globalVariableName: "autopilot_pp", shortName: "app"
// , crxName: "gefs_gc-setup", licenseComment: "Copyright ...", requirejs: {} }
fs.readFileAsync('gefs-build-config.toml')
  .then(file => toml.parse(file))
  .then(magic);

const requirejsDefaults =
  { baseUrl: 'source'
  , name: 'main'
  , out: 'build/code.user.js'
  // Will be manually minifed using UglifyJS2 further down.
  , optimize: 'none'
  , stubModules: [ 'text', 'json' ]
  };

function magic(config) {
  config.requirejs = Object.assign(requirejsDefaults, config.requirejs);

  const optimizing = new Promise(function (resolve, reject) {
    console.log(`Building ${config.name}: ${argv.debug ? 'debug' : 'release'} mode`);
    console.log('Waiting for RequireJS optimisation to complete...');
    requirejs.optimize(config.requirejs, resolve, reject);
  }).catch(function (err) {
    console.error(err);
    process.exit(1);
  }).then(function (buildResponse) {
    // buildResponse is just a text output of the modules
    // included. Load the built file for the contents.
    // Use internalConfig.out to get the optimized file contents.
    console.log(buildResponse);
    const gettingContents = fs.readFileAsync(config.requirejs.out, 'utf-8');

    // Remove the build folder once we've read from it.
    gettingContents.then(() => rimraf('build'));
    return gettingContents;
  });

  const minifying = Promise.join(optimizing, gettingAlmond, function (contents, loader) {
    // The RequireJS loader has to come before the contents of the file.
    contents = loader + '\n' + contents;

    // Disable minification in debug mode.
    if (argv.debug) return contents;

    return UglifyJS.minify(contents,
    { fromString: true
    , output:
      { max_line_len: 400
      , screw_ie8: true
      }
    , compress: { global_defs: { DEBUG: false } }
    }).code;
  });

  const chromeManifest = {
    manifest_version: 2,
    content_scripts: [{
      matches: [],
      js: [ 'c.js' ]
    }]
  };

  fs.readFileAsync(
    path.join(config.requirejs.baseUrl, 'userscript.js'),
    'utf-8'
  ).then(function (file) {
    // Convert \r or \r\n newlines to Unix (\n) standard.
    file = file.replace(/\r\n?/g, '\n');

    // Find Greasemonkey metadata block.
    const greasemonkey = file.slice(
      file.indexOf('// ==UserScript==\n') + 17,
      file.indexOf('// ==/UserScript==')
    );

    const directives = [];
    for (let line of greasemonkey.split('\n')) {
      const match = line.match(/\/\/ @(\S+)(?:\s+(.*))?/);
      if (match) directives.push(match.slice(1));
    }

    for (let keyValue of directives) {
      const key = keyValue[0];
      const value = keyValue[1];

      if (chromeManifest[key] !== undefined) {
        if (Array.isArray(chromeManifest[key])) chromeManifest[key].push(value);
        else chromeManifest[key] = [ chromeManifest[key], value ];
      } else if (key === 'match') {
        chromeManifest.content_scripts[0].matches.push(value);
      } else if (key === 'run-at') {
        chromeManifest.content_scripts[0]['run-at'] = value;
      }
      // elif key == 'namespace' or key == 'grant': pass
      else chromeManifest[key] = value;
    }

    // Check if version was included as argument or not.
    let version = argv.version;
    if (!version) {
      if (chromeManifest.version === undefined) {
        throw new Error('Version missing from Greasemonkey metadata');
      }

      version = chromeManifest.version;
    }

    const list = version.split('.');
    // REVIEW: should we allow other lengths?
    if (list.length !== 3) throw new Error(INVALID_VERSION_ERR);

    for (let val of list) {
      if (!/^(0|[1-9][0-9]{0,4})$/.test(val) || parseInt(val) > 0xFFFF) {
        throw new Error(INVALID_VERSION_ERR);
      }
    }

    chromeManifest.version = version;
    console.log('Version building: ' + version);
    const extension = `${config.shortName}_v${version}${argv.debug ? '-debug' : ''}`;

    minifying.then(function (minified) {
      minified += `\nvar a=window.${config.globalVariableName}={};a.version="${version}";\
a.require=require;a.requirejs=requirejs;a.define=define`;

      const metadata = directives.map(function (arr) {
        const key = arr[0];
        const value = arr[1];

        if (key === 'version') return '// @version ' + version;
        return '// @' + key + ' ' + value;
      }).join('\n');

      let zip = new yazl.ZipFile();

      let licenseComment = config.licenseComment.trim();
      if (licenseComment) {
        licenseComment = '// ' + licenseComment.split(/\r?\n|\r/).join('\n// ') + '\n\n';
      }

      const userscript = `// ==UserScript==
${metadata}
// ==/UserScript==

${licenseComment}${minified}`;

      zip.addBuffer(new Buffer(userscript), extension + '.user.js');

      function customFormat(formatStr) {
        let formattedStr = formatStr;
        for (let i = 1; i < arguments.length; ++i) {
          formattedStr = formattedStr.replace('{' + (i - 1) + '}', arguments[i]);
        }

        return formattedStr;
      }

      const readme = fs.readFileAsync(
        path.join(config.requirejs.baseUrl, 'README.md'),
        'utf-8'
      ).then(function (file) {
        const html = markdown.toHTML(customFormat(file, version, extension));
        zip.addBuffer(new Buffer(html), 'README.html');
      });

      const license = fs.readFileAsync('LICENSE.md').then(file => zip.addBuffer(file, 'LICENSE'));

      const creatingCrx = fs.readFileAsync(argv.pem)
        .then(pem => crx.create(minified, chromeManifest, pem))
        .then(buffer => zip.addBuffer(buffer, `${config.crxName}.crx`, { compress: false }));

      Promise.join(readme, license, creatingCrx, () => zip.end());

      // Ensure the 'package' directory exists -- if not, create it.
      mkdirp('package');
      zip.outputStream.pipe(fs.createWriteStream(util.format(`package/${extension}.zip`, extension)));
    });
  });
}
