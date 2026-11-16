import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultInstallTab } from '../src/installTab.ts';

const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const LINUX_CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

test('Windows platforms default to the ps1 install command, case-insensitively', () => {
  assert.equal(defaultInstallTab('Windows'), 'ps1');
  assert.equal(defaultInstallTab('Win32'), 'ps1');
  assert.equal(defaultInstallTab(WINDOWS_CHROME), 'ps1');
});

test('everything else defaults to the sh install command', () => {
  assert.equal(defaultInstallTab('macOS'), 'sh');
  assert.equal(defaultInstallTab('Linux'), 'sh');
  assert.equal(defaultInstallTab(MAC_SAFARI), 'sh');
  assert.equal(defaultInstallTab(LINUX_CHROME), 'sh');
  assert.equal(defaultInstallTab(''), 'sh');
});
