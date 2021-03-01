/**
 * @license Copyright 2021 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');

/** @typedef {{result?: {value?: string, objectId?: number}, exceptionDetails?: object}} RuntimeEvaluateResponse */

/**
 * https://source.chromium.org/chromium/chromium/src/+/master:third_party/devtools-frontend/src/front_end/test_runner/TestRunner.js;l=170;drc=f59e6de269f4f50bca824f8ca678d5906c7d3dc8
 * @param {Record<string, function>} receiver
 * @param {string} methodName
 * @param {function} override
 */
function addSniffer(receiver, methodName, override) {
  const original = receiver[methodName];
  if (typeof original !== 'function') {
    throw new Error('Cannot find method to override: ' + methodName);
  }

  receiver[methodName] = function() {
    let result;
    try {
      // eslint-disable-next-line prefer-rest-params
      result = original.apply(this, arguments);
    } finally {
      receiver[methodName] = original;
    }
    // In case of exception the override won't be called.
    try {
      // eslint-disable-next-line prefer-rest-params
      Array.prototype.push.call(arguments, result);
      // eslint-disable-next-line prefer-rest-params
      override.apply(this, arguments);
    } catch (e) {
      throw new Error('Exception in overriden method \'' + methodName + '\': ' + e);
    }
    return result;
  };
}

const sniffLhr = `
new Promise(resolve => {
  (${addSniffer.toString()})(
    UI.panels.lighthouse.__proto__,
    '_buildReportUI',
    (lhr, artifacts) => resolve(lhr)
  );
});
`;

const startLighthouse = `
(() => {
  UI.ViewManager.instance().showView('lighthouse');
  const button = UI.panels.lighthouse.contentElement.querySelector('button');
  if (button.disabled) throw new Error('Start button disabled');
  button.click();
})()
`;

async function run() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH,
    devtools: true,
  });
  const page = await browser.newPage();

  const targets = await browser.targets();
  const inspectorTarget = targets.filter(t => t.url().includes('devtools'))[1];
  if (!inspectorTarget) throw new Error('No inspector found.');

  const session = await inspectorTarget.createCDPSession();
  await session.send('Runtime.enable');

  // Navigate to page async so loading doesn't block LH from starting.
  page.goto(process.argv[2]).catch(err => err);

  /** @type {RuntimeEvaluateResponse|undefined} */
  let startLHResponse;
  while (!startLHResponse || startLHResponse.exceptionDetails) {
    startLHResponse = await session.send('Runtime.evaluate', {expression: startLighthouse})
      .catch(err => err);
  }

  /** @type {RuntimeEvaluateResponse} */
  const remoteLhrResponse = await session.send('Runtime.evaluate', {
    expression: sniffLhr,
    awaitPromise: true,
    returnByValue: true,
  }).catch(err => err);

  if (!remoteLhrResponse.result || !remoteLhrResponse.result.value) {
    throw new Error('Problem sniffing LHR.');
  }

  fs.writeFileSync('latest-run/lhr.json', JSON.stringify(remoteLhrResponse.result.value));

  await page.close();
  await browser.close();
}
run();
