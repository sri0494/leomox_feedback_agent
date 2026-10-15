import crypto from 'node:crypto';

export const CATS = ['Drinking water', 'Drainage & sanitation', 'Roads & facilities', 'Civil supplies & pensions', 'Office accessibility'];
export const SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed', 'uncertain'];
export const YNU = ['yes', 'no', 'unknown'];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/* Telephony provider interface (real adapters must implement the same shape):
   { name, isMock, dial({contact,campaign,attempt}) -> { providerCallId, outcome, durationS, answers: [{qi,text,sttConfidence}|{qi,skipped:true}] } }
   Outcomes: completed | declined | opted_out | no_answer | busy | failed.
   Only the mock adapter exists here; it never places real calls and every record it creates is flagged is_mock. */
const BANK = [
  ['Water comes only every other day, usually in the evening.', 'Supply is regular, no problem so far.', 'Some days fine, some days pressure is very low.'],
  ['Sewage is overflowing near the school lane for a week.', 'Drains are cleaned regularly in our street.', 'Cleaning happens but only before the rains.'],
  ['The main road has potholes and no street light at the bend.', 'Roads are okay, the community hall is useful.', 'Road is fine but the bus shelter is broken.'],
  ['Ration came on time but pension was delayed two months.', 'Yes, both reach us without trouble.', 'Ration shop was closed on the scheduled day twice.'],
  ['I called the office twice, nobody replied.', 'Yes I met them and the problem was fixed.', 'I sent a request, still waiting to hear.']
];
export function createMockTelephony(rng = Math.random) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  return {
    name: 'mock', isMock: true,
    async dial() {
      const providerCallId = 'mock_' + crypto.randomBytes(8).toString('hex');
      const r = rng();
      const outcome = r < .55 ? 'completed' : r < .63 ? 'declined' : r < .67 ? 'opted_out' : r < .82 ? 'no_answer' : r < .9 ? 'busy' : 'failed';
      if (outcome !== 'completed') return { providerCallId, outcome, durationS: 0, answers: [] };
      const answers = BANK.map((bank, qi) => {
        if (rng() < .08) return { qi, skipped: true };
        if (rng() < .1) return { qi, text: '[unclear audio] ... the line ...', sttConfidence: 0.31 };
        return { qi, text: pick(bank), sttConfidence: +(0.7 + rng() * 0.25).toFixed(2) };
      });
      return { providerCallId, outcome, durationS: 70 + Math.floor(rng() * 60), answers };
    }
  };
}

/* Classifier interface: classify({text,qi,sttConfidence}) -> object validated by validateClassification.
   The mock is keyword-based; it exists to exercise the pipeline, not to measure real sentiment. */
export function mockClassify({ text, qi, sttConfidence }) {
  const neg = /\b(only|nobody|broken|overflow\w*|delayed|pothole\w*|closed|still waiting|no street light)\b/i.test(text);
  const pos = /\b(fine|regular\w*|okay|fixed|without trouble|useful|no problem)\b/i.test(text);
  const sentiment = /unclear/i.test(text) ? 'uncertain' : neg && pos ? 'mixed' : neg ? 'negative' : pos ? 'positive' : 'neutral';
  let response_received = 'unknown';
  if (qi === 4) response_received = /nobody|waiting|not heard/i.test(text) ? 'no' : /fixed|met them/i.test(text) ? 'yes' : 'unknown';
  return {
    question_id: 'q' + (qi + 1), category: CATS[qi], issue_summary: text.slice(0, 120),
    locality: null, recurrence: null, previously_reported: 'unknown', response_received,
    reported_status: 'unknown', follow_up_requested: false, sentiment,
    confidence: +Math.min(sttConfidence ?? 0.5, sentiment === 'uncertain' ? 0.3 : 0.9).toFixed(2), excerpt: text
  };
}
const KEYS = ['question_id', 'category', 'issue_summary', 'locality', 'recurrence', 'previously_reported', 'response_received', 'reported_status', 'follow_up_requested', 'sentiment', 'confidence', 'excerpt'];
export function validateClassification(o, transcript) {
  const e = [];
  if (!o || typeof o !== 'object') return ['not an object'];
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) e.push('unexpected key ' + k);
  for (const k of KEYS) if (!(k in o)) e.push('missing ' + k);
  if (!CATS.includes(o.category)) e.push('bad category');
  if (!SENTIMENTS.includes(o.sentiment)) e.push('bad sentiment');
  if (!YNU.includes(o.previously_reported) || !YNU.includes(o.response_received)) e.push('bad yes/no/unknown');
  if (typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) e.push('bad confidence');
  if (typeof o.excerpt !== 'string' || !transcript.includes(o.excerpt)) e.push('excerpt is not supporting transcript evidence');
  if (typeof o.follow_up_requested !== 'boolean') e.push('bad follow_up_requested');
  return e;
}

export const URGENT = /overflow|contaminat|no water for/i;

export function verifySignature(secret, rawBody, header) {
  if (!secret || !header) return false;
  const mac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(mac), b = Buffer.from(String(header).replace(/^sha256=/, ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Calling window in India Standard Time. start/end are "HH:MM".
export function inCallingWindow(now, start, end) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const hhmm = parts.find((p) => p.type === 'hour').value.replace('24', '00') + ':' + parts.find((p) => p.type === 'minute').value;
  return hhmm >= start && hhmm < end;
}
