import { newId } from './auth.js';
import { mockClassify, validateClassification, URGENT, inCallingWindow, CATS } from './providers.js';

// Runs up to `limit` pending contacts. Every dial re-checks permission, suppression and the calling window,
// and a contact is claimed atomically (pending -> dialing) so repeated runs/jobs can never double-dial.
export async function runCampaign({ pool, cfg, campaign, telephony, limit = 50, now = new Date() }) {
  const sum = { claimed: 0, completed: 0, skipped_permission: 0, skipped_suppressed: 0, deferred_window: 0, results: {} };
  if (campaign.status !== 'active') throw Object.assign(new Error('Campaign is not active'), { status: 409 });
  const { rows: pending } = await pool.query(
    "SELECT * FROM feedback_contacts WHERE campaign_id=$1 AND status='pending' ORDER BY created_at, id LIMIT $2", [campaign.id, limit]);
  for (const c of pending) {
    const claim = await pool.query("UPDATE feedback_contacts SET status='dialing' WHERE id=$1 AND status='pending' RETURNING id", [c.id]);
    if (!claim.rows.length) continue; // someone else has it
    const setStatus = (s) => pool.query('UPDATE feedback_contacts SET status=$1 WHERE id=$2', [s, c.id]);
    if (!(c.permission === 'granted' && c.permission_at)) { await setStatus('skipped_no_permission'); sum.skipped_permission++; continue; }
    const sup = await pool.query('SELECT 1 FROM feedback_suppression_entries WHERE number=$1', [c.number]);
    if (sup.rows.length) { await setStatus('skipped_suppressed'); sum.skipped_suppressed++; continue; }
    if (!cfg.mockIgnoreWindow && !inCallingWindow(now, campaign.window_start, campaign.window_end)) { await setStatus('pending'); sum.deferred_window++; continue; }
    sum.claimed++;
    const timeline = [{ step: 'eligibility', detail: `permission granted ${c.permission_at}; not suppressed; calling window ${cfg.mockIgnoreWindow ? 'not enforced (mock)' : 'ok'}` }];
    let res, attempts = 0;
    while (attempts <= campaign.retries) {
      attempts++;
      try { res = await telephony.dial({ contact: c, campaign, attempt: attempts }); } catch (e) { res = { providerCallId: 'err_' + newId(), outcome: 'failed', durationS: 0, answers: [] }; }
      timeline.push({ step: 'attempt ' + attempts, detail: res.outcome });
      if (!['no_answer', 'busy', 'failed'].includes(res.outcome)) break;
    }
    const callId = newId();
    if (res.outcome === 'completed') timeline.push({ step: 'disclosure', detail: `automated assistant and purpose stated; recording ${campaign.recording}` });
    if (res.outcome === 'declined') timeline.push({ step: 'consent', detail: 'declined; call ended politely, no questions asked' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO feedback_calls (id,campaign_id,contact_id,provider,provider_call_id,is_mock,outcome,attempts,duration_s,language,recording_stored,timeline) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,FALSE,$11)',
        [callId, campaign.id, c.id, telephony.name, res.providerCallId, !!telephony.isMock, res.outcome, attempts, res.durationS, c.language, JSON.stringify(timeline)]);
      for (const a of res.answers) {
        const qid = 'q' + (a.qi + 1);
        if (a.skipped) { await client.query('INSERT INTO feedback_responses (id,call_id,question_id,category,skipped,classification_status) VALUES ($1,$2,$3,$4,TRUE,$5)', [newId(), callId, qid, CATS[a.qi], 'done']); continue; }
        let cls = null, status = 'pending';
        try { const o = mockClassify({ text: a.text, qi: a.qi, sttConfidence: a.sttConfidence }); if (!validateClassification(o, a.text).length) { cls = o; status = 'done'; } } catch { /* leave pending, raw transcript kept */ }
        const review = status === 'pending' || (cls && cls.confidence < 0.6) || URGENT.test(a.text);
        await client.query('INSERT INTO feedback_responses (id,call_id,question_id,category,transcript,stt_confidence,classification_status,classification,needs_review) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [newId(), callId, qid, CATS[a.qi], a.text, a.sttConfidence, status, cls ? JSON.stringify(cls) : null, review]);
      }
      if (['declined', 'opted_out'].includes(res.outcome))
        await client.query('INSERT INTO feedback_suppression_entries (number,reason) SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM feedback_suppression_entries WHERE number=$1)', [c.number, res.outcome]);
      await client.query('UPDATE feedback_contacts SET status=$1 WHERE id=$2', [res.outcome, c.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      await setStatus('pending'); // nothing persisted for this contact, safe to retry later
      throw e;
    } finally { client.release(); }
    sum.results[res.outcome] = (sum.results[res.outcome] || 0) + 1;
    if (res.outcome === 'completed') sum.completed++;
  }
  return sum;
}
