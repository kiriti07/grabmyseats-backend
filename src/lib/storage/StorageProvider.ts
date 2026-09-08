export interface StorageProviderUploadOptions {
  // "image" (the default) requires Cloudinary to be able to decode the file
  // as an image - fine for screenshots, wrong for an arbitrary forwarded
  // email export (.eml/.pdf/.txt/etc). "raw" stores the bytes as-is.
  resourceType?: "image" | "raw";
  // Subfolder under the provider's root, e.g. "listings" vs
  // "email-forwards" - defaults to "listings" to match prior behavior.
  folder?: string;
}

export interface StorageProvider {
  upload(
    file: Buffer,
    filename: string,
    options?: StorageProviderUploadOptions,
  ): Promise<{ url: string }>;
}
