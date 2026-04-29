const DEFAULT_REDACTION = '[REDACTED]';
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|authorization|cookie|credential|password|refresh[_-]?token|secret|session|token)/i;

const SECRET_STRING_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export interface RedactionOptions {
  replacement?: string;
  extraKeyPatterns?: RegExp[];
  extraValuePatterns?: RegExp[];
}

export function redactSensitive<T>(
  value: T,
  options: RedactionOptions = {},
): T {
  return redactValue(value, {
    replacement: options.replacement ?? DEFAULT_REDACTION,
    keyPatterns: [
      SENSITIVE_KEY_PATTERN,
      ...(options.extraKeyPatterns ?? []),
    ],
    valuePatterns: [
      ...SECRET_STRING_PATTERNS,
      ...(options.extraValuePatterns ?? []),
    ],
    seen: new WeakSet<object>(),
  }) as T;
}

export function redactString(
  value: string,
  options: Pick<RedactionOptions, 'replacement' | 'extraValuePatterns'> = {},
): string {
  const replacement = options.replacement ?? DEFAULT_REDACTION;
  return [...SECRET_STRING_PATTERNS, ...(options.extraValuePatterns ?? [])]
    .reduce((current, pattern) => current.replace(pattern, replacement), value);
}

interface InternalRedactionOptions {
  replacement: string;
  keyPatterns: RegExp[];
  valuePatterns: RegExp[];
  seen: WeakSet<object>;
}

function redactValue(
  value: unknown,
  options: InternalRedactionOptions,
): unknown {
  if (typeof value === 'string') {
    return options.valuePatterns.reduce(
      (current, pattern) => current.replace(pattern, options.replacement),
      value,
    );
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (options.seen.has(value)) {
    return '[Circular]';
  }
  options.seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      const isSensitiveKey = options.keyPatterns.some((pattern) =>
        pattern.test(key),
      );
      return [
        key,
        isSensitiveKey
          ? options.replacement
          : redactValue(child, options),
      ];
    }),
  );
}
