import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Real decoder acceptance, run against the candidate Windows runtime before adoption.
const directory = process.env.MAWJIVO_MEDIA_TEST_DIRECTORY;
for (const format of ['avif', 'jxl']) {
  test(
    `the packaged Windows runtime converts ${format} locally without changing the original`,
    { skip: !directory || process.platform !== 'win32' },
    async () => {
      const source = resolve(`tests/fixtures/media/blue.${format}`);
      const original = await readFile(source);
      const temporary = await mkdtemp(join(tmpdir(), 'mawjivo-media-acceptance-'));
      try {
        const output = join(temporary, 'blue.jpg');
        const decoded = join(temporary, 'decoded.png');
        const bridge = spawnSync(
          join(directory, 'ffmpeg.exe'),
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            source,
            '-frames:v',
            '1',
            '-update',
            '1',
            '-f',
            'image2',
            decoded,
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
        );
        assert.equal(bridge.status, 0, bridge.stderr);
        const conversion = spawnSync(
          join(directory, 'ffmpeg.exe'),
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            decoded,
            '-frames:v',
            '1',
            '-pix_fmt',
            'yuvj420p',
            output,
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
        );
        assert.equal(conversion.status, 0, conversion.stderr);
        const probe = spawnSync(
          join(directory, 'ffprobe.exe'),
          ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', output],
          { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
        );
        assert.equal(probe.status, 0, probe.stderr);
        assert.deepEqual(JSON.parse(probe.stdout).streams, [
          { codec_name: 'mjpeg', width: 32, height: 24 },
        ]);
        assert.deepEqual(await readFile(source), original);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    },
  );
}
