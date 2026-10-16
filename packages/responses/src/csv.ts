/**
 * CSV encoding for exports (RFC 4180, CRLF line endings).
 *
 * Spreadsheet formula injection (docs/04 §7): a cell beginning with
 * =, +, -, @, tab or carriage return can be run as a formula when the file
 * is opened in a spreadsheet. Readable exports prefix such cells with an
 * apostrophe, which spreadsheets show as text. Raw exports are for machines
 * and keep values exactly; they must not be opened in a spreadsheet.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function csvCell(value: string, raw: boolean): string {
  const text = raw ? value : neutralizeFormula(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: readonly string[], raw: boolean): string {
  return `${values.map((v) => csvCell(v, raw)).join(",")}\r\n`;
}

/** Excel reads UTF-8 only with a byte-order mark; raw exports leave it out. */
export const UTF8_BOM = "﻿";
