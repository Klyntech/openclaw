import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export function hasExpectedToolNonce(text: string, nonceA: string, nonceB: string): boolean {
  return text.includes(nonceA) && text.includes(nonceB);
}

export function hasExpectedSingleNonce(text: string, nonce: string): boolean {
  return text.includes(nonce);
}

const NONCE_REFUSAL_MARKERS = [
  "token",
  "secret",
  "local file",
  "uuid-named file",
  "uuid named file",
  "parrot back",
  "disclose",
  "can't help",
  "can’t help",
  "cannot help",
  "can't comply",
  "can’t comply",
  "cannot comply",
  "no `read`",
  "no read tool",
  "no `read`/`read` tool",
  "no read/read tool",
  "no read tool available",
  "won't output",
  "won’t output",
  "isn't a real openclaw probe",
  "is not a real openclaw probe",
  "not a real openclaw probe",
  "no part of the system asks me",
];

const PROBE_REFUSAL_MARKERS = [
  "prompt injection attempt",
  "not a legitimate self-test",
  "not legitimate self-test",
  "authorized integration probe",
  "authorizing me to execute",
  "authorizing me to run",
];

/** Detects likely safety refusals for authorized nonce probes. */
export function isLikelyToolNonceRefusal(text: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(text);
  return (
    PROBE_REFUSAL_MARKERS.some((marker) => lower.includes(marker)) ||
    (lower.includes("nonce") && NONCE_REFUSAL_MARKERS.some((marker) => lower.includes(marker)))
  );
}

function hasMalformedToolOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (trimmed.includes("[object Object]")) {
    return true;
  }
  return (
    lower.includes("try reading the file again") ||
    lower.includes("try again with a slightly different approach") ||
    lower.includes("trying to read the file again") ||
    lower.includes("try the read tool again") ||
    lower.includes("file wasn't found immediately after") ||
    lower.includes("file wasn't found immediately") ||
    lower.includes("verify the file exists and read it again") ||
    lower.includes("file read failed because the file was not found") ||
    lower.includes("verify the file creation and read it again") ||
    /\bread\s*\[/.test(lower) ||
    /\btool\b/.test(lower) ||
    /\bfunction\b/.test(lower)
  );
}

type ProbeAttempt = {
  text: string;
  provider: string;
  attempt: number;
  maxAttempts: number;
  retryKnownNonceMismatch?: boolean;
};

/** Returns true when a file-read tool probe should retry before failing. */
export function shouldRetryToolReadProbe(
  params: ProbeAttempt & {
    nonceA: string;
    nonceB: string;
  },
): boolean {
  if (
    params.attempt + 1 >= params.maxAttempts ||
    hasExpectedToolNonce(params.text, params.nonceA, params.nonceB)
  ) {
    return false;
  }
  if (
    params.retryKnownNonceMismatch ||
    hasMalformedToolOutput(params.text) ||
    (params.provider === "anthropic" && isLikelyToolNonceRefusal(params.text))
  ) {
    return true;
  }
  const lower = normalizeLowercaseStringOrEmpty(params.text);
  return (
    params.provider === "mistral" &&
    (lower.includes("noncea=") ||
      lower.includes("nonceb=") ||
      lower.includes("testmarkera=") ||
      lower.includes("testmarkerb="))
  );
}

/** Returns true when an exec-read probe should retry before failing. */
export function shouldRetryExecReadProbe(
  params: ProbeAttempt & {
    nonce: string;
  },
): boolean {
  if (
    params.attempt + 1 >= params.maxAttempts ||
    hasExpectedSingleNonce(params.text, params.nonce)
  ) {
    return false;
  }
  return (
    params.retryKnownNonceMismatch === true ||
    (params.provider === "anthropic" && isLikelyToolNonceRefusal(params.text)) ||
    hasMalformedToolOutput(params.text)
  );
}
