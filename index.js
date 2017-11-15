#!/usr/bin/env node
'use strict';

// jshint -W079
const Promise = require('bluebird');
// jshint +W079
const fs = Promise.promisifyAll(require('fs'));
const path = require('path');

const toml = require('toml');
const mkdirp = Promise.promisify(require('mkdirp'));
const markdown = require('markdown').markdown;
const requirejs = require('requirejs');
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

// { name: 'Autopilot++', globalVariableName: "autopilot_pp", shortName: "app"
// , crxName: "gefs_gc-setup", licenseComment: "Copyright ...", requirejs: {} }
fs.readFileAsync('gefs-build-config.toml')
  .then(file => toml.parse(file))
  .then(magic);

const requirejsDefaults =
  { baseUrl: 'source'
  , name: 'init'
  , stubModules: [ 'text', 'json' ]
  , optimize: argv.debug ? 'none' : 'uglify2'
  , uglify2:
    { output:
      { max_line_len: 400
      , screw_ie8: true
      }
    , compress: { global_defs: { DEBUG: false } }
    }
  };

function magic(config) {
  config.requirejs = Object.assign(requirejsDefaults, config.requirejs);

  // Insert Almond into the built file.  For legacy reasons, 'name' is moved to 'include'.
  if (config.requirejs.include) config.requirejs.include.push(config.requirejs.name);
  else config.requirejs.include = [ config.requirejs.name ];

  // Note that here the '.js' extension is necessary.
  config.requirejs.name = path.join(__dirname, 'node_modules/almond/almond.js');

  const optimizing = new Promise(function (resolve) {
    console.log(`Building ${config.name}: ${argv.debug ? 'debug' : 'release'} mode`);
    console.log('Waiting for RequireJS optimisation to complete...');

    // Resolve promise with generated file after completing build.
    config.requirejs.out = resolve;

    // Print out information about build instead of leaving it as 'slient'.
    config.requirejs.logLevel = 1;

    // `buildResponse` is just a text output of the modules included.  This is already sent to
    // logger when logLevel is INFO, so this is not necessary.
    // The default errback logs the error, then runs `process.exit(1)` -- this is what we want.
    // `optimize(config, function (buildResponse) {}, errback);`
    requirejs.optimize(config.requirejs);
  });

  const chromeManifest = {
    manifest_version: 2,
    content_scripts: [{
      matches: [],
      js: [ 'wrapper.js' ]
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

    // Parse directives in metadata block.
    const directives = [];
    for (let line of greasemonkey.split('\n')) {
      const match = line.match(/\/\/ @(\S+)(?:\s+(.*))?/);
      if (match) directives.push(match.slice(1));
    }

    // Process directives that have been parsed.
    for (let keyValue of directives) {
      const key = keyValue[0];
      const value = keyValue[1];

      if (chromeManifest[key] !== undefined) {
        if (Array.isArray(chromeManifest[key])) chromeManifest[key].push(value);
        else chromeManifest[key] = [ chromeManifest[key], value ];
      } else if (key === 'match') {
        chromeManifest.content_scripts[0].matches.push(value);
      } else if (key === 'run-at') {
        // Chrome uses underscores instead of hyphens.
        chromeManifest.content_scripts[0]['run_at'] = value.replace('-', '_');
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
    // Name of the ZIP file that will be used as a package.
    const extension = `${config.shortName}_v${version}${argv.debug ? '-debug' : ''}`;

    optimizing.then(function (minified) {
      minified += `\nvar a=window.${config.globalVariableName}={};a.version="${version}";\
a.require=require;a.requirejs=requirejs;a.define=define`;

      const metadata = directives.map(function (arr) {
        const key = arr[0];
        const value = arr[1];

        if (key === 'version') return '// @version ' + version;
        return '// @' + key + ' ' + value;
      }).join('\n');

      let zip = new yazl.ZipFile();

      // Make sure the string exists before attempting to trim it.
      let licenseComment = config.licenseComment ? config.licenseComment.trim() : '';
      if (licenseComment) {
        licenseComment = '// ' + licenseComment.split(/\r?\n|\r/).join('\n// ') + '\n\n';
      }

      const userscript = `// ==UserScript==
${metadata}
// ==/UserScript==

${licenseComment}${minified}`;

      zip.addBuffer(Buffer.from(userscript), extension + '.user.js');

      function customFormat(formatStr) {
        let formattedStr = formatStr;
        for (let i = 1; i < arguments.length; ++i) {
          formattedStr = formattedStr.replace(
            new RegExp('\\{' + (i - 1) + '\\}', 'g'),
            arguments[i]
          );
        }

        return formattedStr;
      }

      // Convert README and LICENSE files from Markdown to HTML.
      const readme = fs.readFileAsync(
        path.join(config.requirejs.baseUrl, 'README.md'),
        'utf-8'
      ).then(function (file) {
        const html = markdown.toHTML(customFormat(file, version, extension, config.crxName));
        zip.addBuffer(Buffer.from(html), 'README.html');
      });

      const license = fs.readFileAsync('LICENSE.md', 'utf-8').then(function (file) {
        const html = markdown.toHTML(file);
        zip.addBuffer(Buffer.from(html), 'LICENSE.html');
      });

      const creatingCrx = fs.readFileAsync(argv.pem)
        .then(pem => crx.create(minified, chromeManifest, pem))
        .then(buffer => zip.addBuffer(buffer, `${config.crxName}.crx`, { compress: false }));

      // Create the ZIP file once everything has been added to it.
      Promise.join(readme, license, creatingCrx, () => zip.end());

      // Ensure the 'package' directory exists -- if not, create it.
      mkdirp('package');

      // Write the ZIP file to the output folder.
      zip.outputStream.pipe(fs.createWriteStream(`package/${extension}.zip`));
    });
  });
}
