import { describe, expect, it } from 'vitest';

import { convertNumbersInFilename } from '../../src/core/assetEnv.js';

describe('convertNumbersInFilename', () => {
  it('handles filename with no numbers', () => {
    expect(convertNumbersInFilename('image.png')).toBe('image_png');
  });

  it('keeps underscores between special characters', () => {
    expect(convertNumbersInFilename('t-3265 (1).png')).toBe('t_3265__1__png');
  });

  it('converts leading numbers to words', () => {
    expect(convertNumbersInFilename('16789675.png')).toBe(
      'sixteenmillionsevenhundredeightyninethousandsixhundredseventyfive_png'
    );
  });

  it('does not convert numbers that are not at the start', () => {
    expect(convertNumbersInFilename('asset16789675.png')).toBe('asset16789675_png');
  });
});
