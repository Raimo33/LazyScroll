// The one place that knows the Decisions API wire format. If OpenAI changes it, fix it here.

const EXPRESSION_QUESTION = {
  type: 'predicate',
  name: 'expression_changed',
  instructions:
    'Image A is the person\'s face when a post appeared on screen; image B is the same person now. ' +
    'Is there a visible change in facial expression from A to B, even a slight one ' +
    '(smile, smirk, raised eyebrows, laugh, surprise, frown)? ' +
    'Ignore blinking, small head turns, gaze shifts, talking and lighting changes.',
};

function buildDecisionRequest(model, baselineJpeg, currentJpeg) {
  return {
    model,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: 'Image A (baseline):' },
        { type: 'input_image', image_url: baselineJpeg },
        { type: 'input_text', text: 'Image B (now):' },
        { type: 'input_image', image_url: currentJpeg },
      ],
    }],
    questions: [EXPRESSION_QUESTION],
  };
}

// Returns P(expression changed) in [0, 1], or null when the model refused / nothing usable came back.
function parseDecisionResponse(json) {
  let answers = json?.answers ?? json?.output?.answers;
  if (answers && !Array.isArray(answers)) {
    answers = Object.entries(answers).map(([name, a]) => ({ name, ...a }));
  }
  const answer = answers?.find((a) => a.name === EXPRESSION_QUESTION.name) ?? answers?.[0];
  if (!answer || answer.type === 'refusal') return null;
  if (typeof answer.probability === 'number') return answer.probability;
  // Tolerate a choice-shaped answer too.
  const yes = answer.probabilities?.find?.((p) => p.value === true || p.value === 'true' || p.value === 'yes');
  if (yes) return yes.probability;
  return null;
}

async function requestDecision({ apiBase, apiKey, model }, baselineJpeg, currentJpeg, signal) {
  const res = await fetch(`${apiBase}/decisions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildDecisionRequest(model, baselineJpeg, currentJpeg)),
    signal,
    priority: 'high',
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error?.message || `HTTP ${res.status}`);
  }
  return { probability: parseDecisionResponse(json), raw: json };
}
