import { FORMATS, type Format } from "../shared/types.js";

export const badRequest = (message: string) => Object.assign(new Error(message), { status: 400 });

/** A video format from a route. Anything else is a bad request. */
export function formatParam(value: unknown): Format {
  if (!FORMATS.includes(value as Format)) throw badRequest(`Unknown format ${String(value)}`);
  return value as Format;
}

/** Refuses a task whose route names an unknown format, before the task starts. Routes without a format pass. */
export function checkFormat(params: Record<string, unknown>) {
  if ("format" in params) formatParam(params.format);
}
