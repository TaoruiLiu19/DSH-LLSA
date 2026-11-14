import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTaskReuseCsvInput } from '../src/task-reuse-csv.js';

async function fixture(t) {
  const state = fileURLToPath(new URL('../.test-state/', import.meta.url));
  await mkdir(state, { recursive: true });
  const root = await realpath(state);
  const directory = await mkdtemp(join(root, 'csv-input-'));
  t.after(async () => {
    assert.equal(dirname(directory), root);
    assert.match(basename(directory), /^csv-input-[A-Za-z0-9]+$/u);
    assert.equal(relative(directory, await realpath(directory)), '');
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = join(directory, 'workspace');
  await mkdir(join(workspace, 'files'), { recursive: true });
  return { directory, workspace };
}

test('workspace CSV snapshot preserves bytes and rejects paths outside scope', async t => {
  const { directory, workspace } = await fixture(t);
  const csv = Buffer.from('\uFEFF编号,状态\r\n007,有效\r\n');
  await writeFile(join(workspace, 'files', '报名.csv'), csv);
  await writeFile(join(directory, 'outside.csv'), csv);
  assert.deepEqual(await readTaskReuseCsvInput(workspace, './files/报名.csv'), csv);
  assert.deepEqual(await readTaskReuseCsvInput(workspace, 'files\\报名.csv'), csv);
  for (const path of ['../outside.csv', 'files\\..\\..\\outside.csv', '/outside.csv',
    'C:\\outside.csv', 'files/AUX.csv', 'files/报名.csv:stream.csv', 'files/报名.txt']) {
    await assert.rejects(readTaskReuseCsvInput(workspace, path), { code: 'CSV_INVALID_PATH' });
  }
  await assert.rejects(readTaskReuseCsvInput(workspace, 'missing.csv'), { code: 'CSV_INPUT_NOT_FOUND' });
});

test('workspace CSV snapshot rejects redirected and oversized files', async t => {
  const { directory, workspace } = await fixture(t);
  const tooLarge = join(workspace, 'large.csv');
  await writeFile(tooLarge, '');
  await truncate(tooLarge, 16 * 1024 * 1024 + 1);
  await assert.rejects(readTaskReuseCsvInput(workspace, 'large.csv'), { code: 'CSV_INPUT_TOO_LARGE' });

  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'data.csv'), 'private,values\n');
  try {
    await symlink(outside, join(workspace, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic('Directory link creation is unavailable on this host.');
    return;
  }
  await assert.rejects(readTaskReuseCsvInput(workspace, 'redirect/data.csv'), { code: 'CSV_INVALID_PATH' });
});
