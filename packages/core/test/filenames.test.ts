import { expect, test } from 'vitest';
import { videoFilename, imageFilename } from '../src/filenames';
test('arabic_emoji_title_preserved_with_safe_filename', () => {
  const title = 'رحلة: القاهرة / مصر 👩🏽‍💻';
  expect(videoFilename(title, 'mp4')).toBe('رحلة القاهرة مصر 👩🏽‍💻.mp4');
  expect(title).toBe('رحلة: القاهرة / مصر 👩🏽‍💻');
});
test('reserved_long_names_and_extensions_are_safe', () => {
  expect(videoFilename('CON', 'mp4')).toBe('فيديو-CON.mp4');
  const name = videoFilename('👩🏽‍💻'.repeat(100), '.mp4');
  expect(name.length).toBeLessThanOrEqual(240);
  expect(name.length).toBeLessThanOrEqual(180);
  expect(name.endsWith('👩🏽‍💻.mp4')).toBe(true);
  expect(() => videoFilename('عنوان', '../exe')).toThrow('INVALID_EXTENSION');
  expect(() => videoFilename('  ', 'mp4')).toThrow('VIDEO_TITLE_REQUIRED');
});
test('transport_name_matches_native_arabic_title_rules', () => {
  expect(videoFilename('عنوان فيديو: اختبار؟', 'mp4')).toBe('عنوان فيديو اختبار؟.mp4');
});
test('images_keep_exact_original_names_unless_the_format_changes', () => {
  expect(imageFilename('صورتي العربية.JPEG', 'image/jpeg', 'image/jpeg')).toBe('صورتي العربية.JPEG');
  expect(imageFilename('صورتي العربية.PNG', 'image/png', 'image/jpeg')).toBe('صورتي العربية.jpg');
  expect(imageFilename('صورة بلا امتداد', 'image/png', 'image/jpeg')).toBe('صورة بلا امتداد.jpg');
  expect(imageFilename('.صورة', 'image/png', 'image/jpeg')).toBe('.صورة.jpg');
});
