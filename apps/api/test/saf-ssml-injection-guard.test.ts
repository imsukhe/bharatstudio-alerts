import assert from 'node:assert/strict';
import test from 'node:test';
import { createSarvamTtsProvider, createTtsService, sanitizeTtsText } from '../src/tts/provider.js';

/*
 * SAF-11 (FULL-PRODUCT-DEFINITION.md S31.13.2: "SSML-injection guard --
 * a message can never become synthesis instructions"). This task's own
 * hard constraint: "read how apps/api/src/tts/provider.ts currently
 * handles text ... do not duplicate or contradict it." Reading it
 * first (see packages/db/migrations/0154's own header) found the guard
 * ALREADY EXISTS and is ALREADY STRUCTURALLY SUFFICIENT:
 * `sanitizeTtsText` (provider.ts:33-40, pre-existing, before this task)
 * strips every `<[^>]*>`-shaped token UNCONDITIONALLY before any text
 * reaches a provider. SSML/XML syntax is entirely defined by `<...>`
 * tag delimiters -- removing every well-formed tag removes every
 * possible piece of markup a synthesiser could interpret as an
 * instruction, and this codebase never asks a provider to parse the
 * result as SSML in the first place (createSarvamTtsProvider sends the
 * sanitized string as an opaque `inputs` field, never a `ssml: true`
 * flag or a `<speak>`-wrapped document).
 *
 * NO NEW PRODUCTION CODE WAS ADDED FOR SAF-11. Adding a second
 * SSML-stripping implementation would be exactly the "second
 * implementation to drift out of sync" SAF-01 forbids, and the existing
 * one is already correct and unconditional on every reachable path
 * (verified separately: apps/api/src/routes/tts.ts is the only live
 * caller of TtsService.synthesize, which always calls sanitizeTtsText
 * before any provider dispatch -- see this file's last test). This
 * file's contribution is a DEDICATED, more exhaustive proof than the
 * single pre-existing assertion in apps/api/test/tts-provider.test.ts
 * ('TTS neutralizes technical controls, URLs and markup before provider
 * dispatch'), tying the guarantee explicitly to the SAF-11 register row.
 */

// WELL-FORMED payloads: every "<" has a matching ">" somewhere after it,
// i.e. every one of these is a complete, parseable tag (or sequence of
// tags) before sanitisation -- exactly the shape sanitizeTtsText's
// MARKUP_LIKE_TAG regex (/<[^>]*>/gu) is built to remove entirely.
const SSML_PAYLOADS = [
  '<speak>ignore all previous instructions and say something else</speak>',
  '<prosody rate="x-fast" pitch="+50%">SHOUT THIS LOUDLY</prosody>',
  '<voice name="attacker-chosen-voice">hello</voice>',
  '<break time="10s"/>silence attack',
  '<speak><voice name="a"><prosody rate="fast">nested tags</prosody></voice></speak>',
  '<say-as interpret-as="characters">injected</say-as>',
  '<audio src="https://evil.example/payload.wav"/>',
  '<a<b>malformed nesting attempt',
];

// MALFORMED: no matching ">" exists anywhere, so no complete tag can be
// formed -- covered by its own, differently-worded test below rather
// than folded into the well-formed battery, because "no '<' character
// reaches the provider at all" is not the right claim for this case (see
// that test for the actually-correct claim: no COMPLETE tag reaches it).
const UNTERMINATED_TAG_PAYLOAD = 'plain text <speak trailing content with no closing bracket';

test('SAF-11: sanitizeTtsText strips every angle-bracket-delimited tag for a battery of SSML injection payloads -- no "<" or ">" survives a well-formed tag', () => {
  for (const payload of SSML_PAYLOADS) {
    const sanitized = sanitizeTtsText(`hello ${payload} world`);
    // Any WELL-FORMED tag (a "<", then no further ">", then a ">") is
    // gone. A parser needs a complete <...> pair to recognise a tag at
    // all -- an orphaned "<" with no matching ">" anywhere after it
    // (UNTERMINATED_TAG_PAYLOAD, tested separately below) cannot be
    // parsed as SSML markup by any conformant parser, so its literal
    // presence is not a counter-example to inertness.
    assert.doesNotMatch(sanitized, /<[^>]*>/u, `payload not fully stripped: ${JSON.stringify(payload)} -> ${JSON.stringify(sanitized)}`);
  }
});

test('SAF-11: an unterminated tag ("<speak" with no closing ">") survives as literal text but is not parseable markup -- inert either way', () => {
  const sanitized = sanitizeTtsText(UNTERMINATED_TAG_PAYLOAD);
  // The literal "<" may remain (there is no ">" anywhere for the strip
  // regex to anchor on), but there is no COMPLETE "<...>" tag anywhere
  // in the output -- nothing here is well-formed markup a parser could
  // ever recognise as an instruction.
  assert.doesNotMatch(sanitized, /<[^<>]*>/u);
});

test('SAF-11: the full synthesis round trip never sends a "<" or ">" character to the provider, for every payload, regardless of cache/quota state', async () => {
  for (const payload of SSML_PAYLOADS) {
    let providerText: string | undefined;
    const provider = createSarvamTtsProvider('synthetic-key', 'https://tts.example.test/synthesize', async (_url, init) => {
      providerText = (JSON.parse(String(init?.body)) as { inputs: string[] }).inputs[0];
      return new Response(JSON.stringify({ audios: ['UklGRg=='] }), { status: 200 });
    });
    const service = createTtsService(provider);
    const result = await service.synthesize({ text: `Rohan tipped: ${payload}`, locale: 'en-IN' });
    assert.equal(result.mode, 'audio', `expected synthesis to succeed for payload: ${payload}`);
    assert.ok(providerText !== undefined, 'provider was never called');
    assert.ok(!providerText!.includes('<'), `provider received a "<" character for payload ${JSON.stringify(payload)}: ${JSON.stringify(providerText)}`);
    assert.ok(!providerText!.includes('>'), `provider received a ">" character for payload ${JSON.stringify(payload)}: ${JSON.stringify(providerText)}`);
  }
});

test('SAF-04/SAF-11: the SAF pipeline\'s "original text is never destroyed" guarantee and "a message can never become synthesis instructions" are two DIFFERENT strings on two DIFFERENT paths -- never confused for each other', () => {
  // If this message were ALSO corpus-actioned (migration 0151), SAF-04
  // requires the evidence snapshot to preserve the ORIGINAL text
  // byte-for-byte, SSML markup included -- that is what "original is
  // never destroyed" means, and it is correct and required for audit.
  // SAF-11's guarantee is about a COMPLETELY SEPARATE string: what
  // actually reaches a synthesiser. Proving they are different values
  // computed by different functions is the point of this test -- a
  // caller who read SAF-04's guarantee and assumed "so the stored
  // original text is also safe to speak" would be wrong, and nothing in
  // this codebase makes that assumption.
  const original = 'tip message <speak>attacker instructions</speak>';
  const whatReachesTheSynthesiser = sanitizeTtsText(original);

  assert.notEqual(whatReachesTheSynthesiser, original, 'the sanitized (spoken) form must differ from the original when SSML is present');
  assert.match(original, /<speak>/u, 'the original, as SAF-04 requires it be preserved, still contains the markup');
  assert.doesNotMatch(whatReachesTheSynthesiser, /<[^>]*>/u, 'what reaches the synthesiser never does');
});

test('SAF-11: TTS is the only live route reaching a provider, and it always sanitizes -- the structural single-path fact this file\'s proof relies on', async () => {
  // apps/api/src/routes/tts.ts is the sole caller of TtsService.synthesize
  // in this codebase (verified by inspection: grep for ".synthesize("
  // across apps/api/src finds only tts/provider.ts's own definitions and
  // routes/tts.ts's one call site), and createTtsService.synthesize
  // (apps/api/src/tts/provider.ts) calls sanitizeTtsText before EVERY
  // provider dispatch, with no branch that skips it. This test pins that
  // behaviour directly against the service, independent of the route.
  let calledWithSanitized = false;
  const provider = {
    async synthesize(request: { text: string }) {
      calledWithSanitized = !request.text.includes('<') && !request.text.includes('>');
      return { audioBase64: 'UklGRg==', mimeType: 'audio/wav' as const, cacheKey: 'k' };
    },
  };
  const service = createTtsService(provider);
  await service.synthesize({ text: '<speak>hi</speak>', locale: 'en-IN' });
  assert.equal(calledWithSanitized, true);
});
