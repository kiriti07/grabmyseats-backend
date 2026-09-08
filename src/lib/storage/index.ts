import type { StorageProvider } from "./StorageProvider";
import { CloudinaryStorageProvider } from "./CloudinaryStorageProvider";

export type { StorageProvider };

// The rest of the app only depends on the StorageProvider interface, so
// swapping providers (e.g. to Cloudflare R2) is a one-file change: add
// e.g. R2StorageProvider (implementing StorageProvider) next to
// CloudinaryStorageProvider, then swap the line below.
export const storageProvider: StorageProvider = new CloudinaryStorageProvider();
