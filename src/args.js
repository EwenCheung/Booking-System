export function parseArguments(values) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const equalIndex = value.indexOf("=");
    if (equalIndex > -1) {
      flags[value.slice(2, equalIndex)] = value.slice(equalIndex + 1);
      continue;
    }

    const name = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }

  return { positional, flags };
}

export function requireFlags(flags, names) {
  const missing = names.filter((name) => !flags[name]);
  if (missing.length) {
    throw new Error(`Missing required option(s): ${missing.map((name) => `--${name}`).join(", ")}`);
  }
}

export function numberFlag(flags, name, fallback) {
  if (flags[name] === undefined) return fallback;
  const result = Number(flags[name]);
  if (!Number.isFinite(result)) {
    throw new Error(`--${name} must be a number.`);
  }
  return result;
}
