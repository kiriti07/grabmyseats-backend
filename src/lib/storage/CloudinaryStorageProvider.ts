import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import type { StorageProvider, StorageProviderUploadOptions } from "./StorageProvider";

// Reads CLOUDINARY_URL (cloudinary://<api_key>:<api_secret>@<cloud_name>)
// from the environment.
cloudinary.config();

function toPublicId(filename: string): string {
  return filename
    .replace(/\.[^./]+$/, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-");
}

export class CloudinaryStorageProvider implements StorageProvider {
  async upload(
    file: Buffer,
    filename: string,
    options?: StorageProviderUploadOptions,
  ): Promise<{ url: string }> {
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `grabmyseats/${options?.folder ?? "listings"}`,
          public_id: toPublicId(filename),
          resource_type: options?.resourceType ?? "image",
        },
        (error, uploadResult) => {
          if (error || !uploadResult) {
            reject(error ?? new Error("Cloudinary upload failed"));
            return;
          }
          resolve(uploadResult);
        },
      );
      stream.end(file);
    });

    return { url: result.secure_url };
  }
}
