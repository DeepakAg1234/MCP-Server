const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const CONTROLS = /[\u0000-\u001F\u007F]/;

export type ParsedAddress = {
  original: string;
  local: string;
  domain: string;
};

export function parseAddress(value: string): { ok: true; value: ParsedAddress } | { ok: false; message: string } {
  if (value.length < 3 || value.length > 254) {
    return { ok: false, message: `Invalid email address: ${value}` };
  }
  if (CONTROLS.test(value) || /[\s,;<>"'()]/.test(value)) {
    return { ok: false, message: `Invalid email address: ${value}` };
  }
  if (!ADDRESS.test(value)) {
    return { ok: false, message: `Invalid email address: ${value}` };
  }
  const at = value.lastIndexOf("@");
  return {
    ok: true,
    value: {
      original: value,
      local: value.slice(0, at),
      domain: value.slice(at + 1).toLowerCase(),
    },
  };
}

export function parseAddressList(values: readonly string[]): { ok: true } | { ok: false; message: string } {
  for (const value of values) {
    const parsed = parseAddress(value);
    if (!parsed.ok) return parsed;
  }
  return { ok: true };
}

export function domainOf(address: string): string {
  const parsed = parseAddress(address);
  if (!parsed.ok) return "";
  return parsed.value.domain;
}

export function domainsEqual(left: string, right: string): boolean {
  return domainOf(left) === domainOf(right);
}

export function assertHeaderText(value: string, field: string): { ok: true } | { ok: false; message: string } {
  if (CONTROLS.test(value)) {
    return { ok: false, message: `${field} contains a control character` };
  }
  return { ok: true };
}
