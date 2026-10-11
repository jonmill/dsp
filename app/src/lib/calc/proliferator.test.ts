import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GameDataIndex, parseGameData } from '../data';
import { canUseExtra, effectFor, proliferatorItemId, spraysPerItem } from './proliferator';

const fixturePath = fileURLToPath(new URL('../../../../data/fixture/dsp-fixture.json', import.meta.url));
const data = new GameDataIndex(parseGameData(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown, 'dsp-fixture.json'));

const processor = data.recipe(51);
const reformedRefinement = data.recipe(121); // nonProductive
const assemblerMk2 = data.recipe(46); // consumes an Assembling Machine Mk.I, a non-productive item

describe('proliferatorItemId and spraysPerItem', () => {
  it('maps tier n to item 1140+n', () => {
    expect([1, 2, 3].map((t) => proliferatorItemId(t as 1 | 2 | 3))).toEqual([1141, 1142, 1143]);
  });

  it('reads the sprays per item from the item (Mk.III is 60)', () => {
    expect(spraysPerItem(1, data)).toBe(12);
    expect(spraysPerItem(2, data)).toBe(24);
    expect(spraysPerItem(3, data)).toBe(60);
  });
});

describe('canUseExtra', () => {
  it('is true for a productive recipe whose inputs are all productive', () => {
    expect(canUseExtra(processor, data)).toBe(true);
  });

  it('is false for a nonProductive recipe', () => {
    expect(canUseExtra(reformedRefinement, data)).toBe(false);
  });

  it('is false when an input item is not productive', () => {
    expect(data.item(2303).productive).toBe(false);
    expect(canUseExtra(assemblerMk2, data)).toBe(false);
  });
});

describe('effectFor', () => {
  it('is the identity without a proliferator', () => {
    expect(effectFor(0, 'extra', processor, data)).toEqual({
      outputMultiplier: 1,
      speedMultiplier: 1,
      powerMultiplier: 1,
      proliferated: false,
    });
  });

  it('Mk.I extra products: x1.125 output, no speed-up, x1.3 power', () => {
    expect(effectFor(1, 'extra', processor, data)).toEqual({
      outputMultiplier: 1.125,
      speedMultiplier: 1,
      powerMultiplier: 1.3,
      proliferated: true,
    });
  });

  it('Mk.III extra products: x1.25 output, x2.5 power', () => {
    expect(effectFor(3, 'extra', processor, data)).toEqual({
      outputMultiplier: 1.25,
      speedMultiplier: 1,
      powerMultiplier: 2.5,
      proliferated: true,
    });
  });

  it('Mk.II extra products: ability 2 gives x1.2 output and x1.7 power', () => {
    const e = effectFor(2, 'extra', processor, data);
    expect(e.outputMultiplier).toBeCloseTo(1.2, 12);
    expect(e.powerMultiplier).toBeCloseTo(1.7, 12);
  });

  it('Mk.III speed-up: x2 speed, no extra output, x2.5 power', () => {
    expect(effectFor(3, 'speed', processor, data)).toEqual({
      outputMultiplier: 1,
      speedMultiplier: 2,
      powerMultiplier: 2.5,
      proliferated: true,
    });
  });

  it('falls back to speed-up for a nonProductive recipe', () => {
    expect(effectFor(2, 'extra', reformedRefinement, data)).toEqual({
      outputMultiplier: 1,
      speedMultiplier: 1.5,
      powerMultiplier: 1.7,
      proliferated: true,
    });
  });

  it('falls back to speed-up when an input is not productive', () => {
    const e = effectFor(3, 'extra', assemblerMk2, data);
    expect(e.outputMultiplier).toBe(1);
    expect(e.speedMultiplier).toBe(2);
  });
});
