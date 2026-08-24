const ANSI_PATTERN =
  // Matches CSI (ESC[) and other ANSI control sequences.
  /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;
const OSC_PATTERN = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const sanitizeLogEntry = (value: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    return "";
  }

  let result = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  result = result.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");
  result = result.replace(CONTROL_PATTERN, "");
  return result;
};
