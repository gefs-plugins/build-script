'use strict';

const yazl = require('yazl');
const util = require('util');
const fs = require('fs');
const crypto = require('crypto');

const NodeRSA = require('node-rsa');
const streamToArray = require('stream-to-array');
const jsStringEscape = require('js-string-escape');

const crx3 = require('crx3');

const gettingWrapper = fs.promises.readFile(__dirname + '/wrapper.js');

function createZip(code, chromeManifest) {
  let zip = new yazl.ZipFile();

  // We have to wrap the JS code in an IIFE because we directly inject
  // the script into the global page in the Chrome extension, while
  // Greasemonkey wraps any userscripts in its own context.
  code = `!function(){
${code}
}()`;

  zip.addBuffer(Buffer.from(code), 'code.js');
  gettingWrapper.then(function (wrapperBuf) {
    zip.addBuffer(wrapperBuf, 'wrapper.js');
    zip.end();
  });

  zip.addBuffer(Buffer.from(JSON.stringify(chromeManifest)), 'manifest.json');
  return zip.outputStream;
}

function getSignature(stream, pem) {
  return new Promise(function (resolve, reject) {
    let sign = crypto.createSign('RSA-SHA1');
    stream.pipe(sign);

    sign.on('finish', function () {
      try {
        resolve(sign.sign(pem));
      } catch (e) {
        reject(e);
      }
    });

    sign.on('error', function (e) {
      this.end();
      reject(e);
    });
  });
}

exports.createCrx3 = function (code, chromeManifest, pem, crx) {
    const zipStream = createZip(code, chromeManifest);
    return crx3(zipStream, {
        keyPath: pem,
        crxPath: crx
    });
}

exports.create = function (code, chromeManifest, pem) {
  const zipStream = createZip(code, chromeManifest);
  const gettingSignature = getSignature(zipStream, pem);
  const zipBuffering = streamToArray(zipStream).then(arr => Buffer.concat(arr));

  const key = new NodeRSA(pem);
  const publicKey = key.exportKey('pkcs8-public-der');

  return Promise.all([zipBuffering, gettingSignature]).then(([buffer, signature]) => {
    // The Chrome documentation says it's 4-byte aligned, but in reality it isn't.
    const crx = Buffer.alloc(16 + publicKey.length + signature.length + buffer.length);
    // Cr24 magic number
    crx.writeUInt32BE(0x43723234, 0);
    // Version of CRX format (2)
    crx.writeUInt32LE(2, 4);
    // Length of RSA public key in bytes.
    crx.writeUInt32LE(publicKey.length, 8);
    // Length of RSA signature in bytes.
    crx.writeUInt32LE(signature.length, 12);

    publicKey.copy(crx, 16);
    signature.copy(crx, 16 + publicKey.length);
    buffer.copy(crx, 16 + publicKey.length + signature.length);
    return crx;
  });
};
