import { RESPONSES_ROUTING } from "../config/responsesRouting.js";

export function createRequestBudget(signal = null, maxAttempts = RESPONSES_ROUTING.maxAttempts) {
  return { attempts: 0, maxAttempts, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(RESPONSES_ROUTING.deadlineMs)]) : AbortSignal.timeout(RESPONSES_ROUTING.deadlineMs) };
}

export function checkRequestBudget(budget, consume = false) {
  if (!budget) return;
  if (budget.signal?.aborted) {
    if (budget.signal.reason?.name === "TimeoutError") throw Object.assign(new Error("routing_deadline_exceeded: upstream request deadline reached"), { status: 504 });
    budget.signal.throwIfAborted();
  }
  if (budget.attempts >= budget.maxAttempts) {
    const error = new Error("routing_budget_exhausted: maximum upstream attempts reached");
    error.status = 503;
    throw error;
  }
  if (consume) budget.attempts++;
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
