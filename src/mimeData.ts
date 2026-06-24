import type { ReadonlyPartialJSONValue } from '@lumino/coreutils';

/**
 * Parse a JSON-typed value that may have arrived as a string. Agents and the
 * MCP bridge sometimes serialize a spec (e.g. a Vega-Lite object) to a string;
 * for `application/...json` MIME types we accept either and parse the string.
 */
export function coerceData(
  mimeType: string,
  data: ReadonlyPartialJSONValue
): ReadonlyPartialJSONValue {
  if (typeof data === 'string' && /\+?json$/.test(mimeType)) {
    try {
      return JSON.parse(data) as ReadonlyPartialJSONValue;
    } catch {
      return data;
    }
  }
  return data;
}
