// Hangul as the 두벌식 keys that compose it (docs/remote.md, 「The on-screen keyboard」). The desktop's
// input method composes syllables from those keys, so a character the session's keymap has no key
// for is typed the way a physical keyboard would type it. A key is written as the Latin letter on it,
// upper-case where Shift is held.

const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const COMPAT_CONSONANT_FIRST = 0x3131;
const COMPAT_VOWEL_FIRST = 0x314f;
const COMPAT_LAST = 0x3163;

const INITIALS = ["r", "R", "s", "e", "E", "f", "a", "q", "Q", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"];
const VOWELS = ["k", "o", "i", "O", "j", "p", "u", "P", "h", "hk", "ho", "hl", "y", "n", "nj", "np", "nl", "b", "m", "ml", "l"];
const FINALS = ["", "r", "R", "rt", "s", "sw", "sg", "e", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg", "a", "q", "qt", "t", "T", "d", "w", "c", "z", "x", "v", "g"];
// ㄱ ㄲ ㄳ ㄴ ㄵ ㄶ ㄷ ㄸ ㄹ ㄺ ㄻ ㄼ ㄽ ㄾ ㄿ ㅀ ㅁ ㅂ ㅃ ㅄ ㅅ ㅆ ㅇ ㅈ ㅉ ㅊ ㅋ ㅌ ㅍ ㅎ
const COMPAT_CONSONANTS = ["r", "R", "rt", "s", "sw", "sg", "e", "E", "f", "fr", "fa", "fq", "ft", "fx", "fv", "fg", "a", "q", "Q", "qt", "t", "T", "d", "w", "W", "c", "z", "x", "v", "g"];

export interface HangulKeys {
  // The keys, as the letters on them.
  keys: string;
  // A lone jamo rather than a whole syllable: it would join a jamo beside it.
  lone: boolean;
}

// The keys of one character, or null where it is not a Hangul syllable or compatibility jamo.
export function hangulKeys(character: string): HangulKeys | null {
  const point = character.codePointAt(0) ?? 0;

  if (point >= SYLLABLE_FIRST && point <= SYLLABLE_LAST) {
    const index = point - SYLLABLE_FIRST;
    const final = index % FINALS.length;
    const vowel = Math.floor(index / FINALS.length) % VOWELS.length;
    const initial = Math.floor(index / (FINALS.length * VOWELS.length));

    return { keys: INITIALS[initial]! + VOWELS[vowel]! + FINALS[final]!, lone: false };
  }

  if (point >= COMPAT_CONSONANT_FIRST && point < COMPAT_VOWEL_FIRST) return { keys: COMPAT_CONSONANTS[point - COMPAT_CONSONANT_FIRST]!, lone: true };
  if (point >= COMPAT_VOWEL_FIRST && point <= COMPAT_LAST) return { keys: VOWELS[point - COMPAT_VOWEL_FIRST]!, lone: true };

  return null;
}
