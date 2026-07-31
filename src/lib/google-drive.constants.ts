/**
 * Shared between the browser-side Google Picker (`google-picker.ts`) and the
 * server-side Drive calls (`google-drive.functions.ts`), which both need to
 * recognise a folder and must agree on how.
 */
export const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

/**
 * How the manager's destination folder was configured. It decides what we may
 * do when the folder turns out to be gone: a folder resolved from a typed name
 * can be recreated under that name, but one chosen in the picker cannot be
 * recreated without silently pointing waivers at a different folder (in a
 * different drive, even) than the one they chose.
 */
export type DriveFolderSource = "picker" | "name";
