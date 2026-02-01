import json
import math
import hashlib
import os
import base64
from io import BytesIO

import numpy as np
import torch
from PIL import Image, ImageOps, ImageSequence

import folder_paths
import node_helpers
import comfy.utils


class ReferenceChainConditioning:
    """
    A node that takes multiple images as input through a dynamic list UI,
    processes them (scale + VAE encode), and chains them through Reference Latent
    conditioning - outputting a single Conditioning that contains all reference latents.
    """

    upscale_methods = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "neg_conditioning": ("CONDITIONING",),
                "vae": ("VAE",),
                "upscale_method": (cls.upscale_methods, {"default": "lanczos"}),
                "scale_megapixels": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.01,
                    "max": 16.0,
                    "step": 0.01,
                }),
                "images": ("STRING", {
                    "default": "[]",
                    "multiline": False,
                    "image_list_upload": True,  # Custom flag for frontend
                }),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "IMAGE")
    RETURN_NAMES = ("conditioning", "neg_conditioning", "first_image_scaled")
    FUNCTION = "process"
    CATEGORY = "conditioning"

    def load_image(self, image_path):
        """Load a single image from the input directory and convert to tensor."""
        img = node_helpers.pillow(Image.open, image_path)

        output_images = []
        w, h = None, None

        for i in ImageSequence.Iterator(img):
            i = node_helpers.pillow(ImageOps.exif_transpose, i)

            if i.mode == 'I':
                i = i.point(lambda x: x * (1 / 255))
            image = i.convert("RGB")

            if len(output_images) == 0:
                w = image.size[0]
                h = image.size[1]

            if image.size[0] != w or image.size[1] != h:
                continue

            image = np.array(image).astype(np.float32) / 255.0
            image = torch.from_numpy(image)[None,]
            output_images.append(image)

            if img.format == "MPO":
                break  # ignore all frames except the first one for MPO format

        if len(output_images) > 1:
            output_image = torch.cat(output_images, dim=0)
        elif len(output_images) == 1:
            output_image = output_images[0]
        else:
            raise ValueError(f"Could not load image from {image_path}")

        return output_image

    def scale_image(self, image, upscale_method, megapixels):
        """Scale image to target megapixels."""
        # Image is in BHWC format, move to BCHW for upscaling
        samples = image.movedim(-1, 1)
        total = megapixels * 1024 * 1024

        scale_by = math.sqrt(total / (samples.shape[3] * samples.shape[2]))
        width = round(samples.shape[3] * scale_by)
        height = round(samples.shape[2] * scale_by)

        # Ensure dimensions are at least 8 (VAE requirement)
        width = max(8, width)
        height = max(8, height)

        s = comfy.utils.common_upscale(samples, width, height, upscale_method, "disabled")
        # Move back to BHWC
        s = s.movedim(1, -1)
        return s

    def process(self, conditioning, neg_conditioning, vae, upscale_method, scale_megapixels, images):
        """
        Process multiple images and chain them as reference latents.

        Args:
            conditioning: Input conditioning to append reference latents to
            neg_conditioning: Input negative conditioning to append reference latents to
            vae: VAE model for encoding images to latents
            upscale_method: Method for scaling images
            scale_megapixels: Target megapixels for image scaling
            images: JSON array of image filenames

        Returns:
            Conditioning with all reference latents appended
        """
        # Parse JSON array of image filenames
        try:
            images_list = json.loads(images)
        except json.JSONDecodeError:
            images_list = []

        if not isinstance(images_list, list):
            images_list = []

        # Filter out empty strings
        images_list = [img for img in images_list if img and isinstance(img, str)]

        # If no images, return conditioning unchanged with empty image
        if not images_list:
            # Return empty 1x1 black image as placeholder
            empty_image = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
            return (conditioning, neg_conditioning, empty_image)

        # Process each image
        result_conditioning = conditioning
        result_neg_conditioning = neg_conditioning
        first_scaled_image = None

        for image_filename in images_list:
            # Get full path using folder_paths
            image_path = folder_paths.get_annotated_filepath(image_filename)

            if not os.path.exists(image_path):
                print(f"[ReferenceChainConditioning] Warning: Image not found: {image_path}")
                continue

            # Load image
            image_tensor = self.load_image(image_path)

            # Scale to target megapixels
            scaled_image = self.scale_image(image_tensor, upscale_method, scale_megapixels)

            # Store first scaled image for output
            if first_scaled_image is None:
                first_scaled_image = scaled_image

            # VAE encode
            # VAE expects BHWC format with values 0-1
            latent_samples = vae.encode(scaled_image[:, :, :, :3])

            # Append to conditioning using the same method as ReferenceLatent
            result_conditioning = node_helpers.conditioning_set_values(
                result_conditioning,
                {"reference_latents": [latent_samples]},
                append=True
            )
            
            # Append to negative conditioning as well
            result_neg_conditioning = node_helpers.conditioning_set_values(
                result_neg_conditioning,
                {"reference_latents": [latent_samples]},
                append=True
            )

        # Ensure we have a first image (fallback to empty if somehow none processed)
        if first_scaled_image is None:
            first_scaled_image = torch.zeros((1, 1, 1, 3), dtype=torch.float32)

        return (result_conditioning, result_neg_conditioning, first_scaled_image)

    @classmethod
    def IS_CHANGED(cls, conditioning, neg_conditioning, vae, upscale_method, scale_megapixels, images):
        """Check if the node needs to be re-executed based on image changes."""
        try:
            images_list = json.loads(images)
        except json.JSONDecodeError:
            return ""

        if not isinstance(images_list, list):
            return ""

        # Create a hash of all image files
        m = hashlib.sha256()

        for image_filename in images_list:
            if not image_filename or not isinstance(image_filename, str):
                continue

            image_path = folder_paths.get_annotated_filepath(image_filename)

            if os.path.exists(image_path):
                with open(image_path, 'rb') as f:
                    m.update(f.read())

        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(cls, conditioning, neg_conditioning, vae, upscale_method, scale_megapixels, images):
        """Validate that all specified images exist."""
        try:
            images_list = json.loads(images)
        except json.JSONDecodeError:
            return True  # Empty/invalid JSON is okay, just means no images

        if not isinstance(images_list, list):
            return True

        for image_filename in images_list:
            if not image_filename or not isinstance(image_filename, str):
                continue

            if not folder_paths.exists_annotated_filepath(image_filename):
                return f"Invalid image file: {image_filename}"

        return True


class ReferenceChainConditioningBase64:
    """
    A node that takes multiple base64-encoded images as input,
    processes them (scale + VAE encode), and chains them through Reference Latent
    conditioning - outputting a single Conditioning that contains all reference latents.

    This version is optimized for API usage where images are passed directly as base64 strings.
    """

    upscale_methods = ["nearest-exact", "bilinear", "area", "bicubic", "lanczos"]

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "conditioning": ("CONDITIONING",),
                "neg_conditioning": ("CONDITIONING",),
                "vae": ("VAE",),
                "upscale_method": (cls.upscale_methods, {"default": "lanczos"}),
                "scale_megapixels": ("FLOAT", {
                    "default": 1.0,
                    "min": 0.01,
                    "max": 16.0,
                    "step": 0.01,
                }),
                "images_base64": ("STRING", {
                    "default": "[]",
                    "multiline": True,
                }),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "IMAGE")
    RETURN_NAMES = ("conditioning", "neg_conditioning", "first_image_scaled")
    FUNCTION = "process"
    CATEGORY = "conditioning"

    def load_image_from_base64(self, base64_data):
        """Load a single image from base64 string and convert to tensor."""
        # Handle data URL prefix if present (e.g., "data:image/png;base64,...")
        if "," in base64_data:
            base64_data = base64_data.split(",", 1)[1]

        # Decode base64
        image_data = base64.b64decode(base64_data)

        # Open with PIL
        img = Image.open(BytesIO(image_data))

        # Handle EXIF orientation
        img = ImageOps.exif_transpose(img)

        # Convert to RGB
        if img.mode == 'I':
            img = img.point(lambda x: x * (1 / 255))
        image = img.convert("RGB")

        # Convert to tensor
        image_np = np.array(image).astype(np.float32) / 255.0
        image_tensor = torch.from_numpy(image_np)[None,]

        return image_tensor

    def scale_image(self, image, upscale_method, megapixels):
        """Scale image to target megapixels."""
        # Image is in BHWC format, move to BCHW for upscaling
        samples = image.movedim(-1, 1)
        total = megapixels * 1024 * 1024

        scale_by = math.sqrt(total / (samples.shape[3] * samples.shape[2]))
        width = round(samples.shape[3] * scale_by)
        height = round(samples.shape[2] * scale_by)

        # Ensure dimensions are at least 8 (VAE requirement)
        width = max(8, width)
        height = max(8, height)

        s = comfy.utils.common_upscale(samples, width, height, upscale_method, "disabled")
        # Move back to BHWC
        s = s.movedim(1, -1)
        return s

    def process(self, conditioning, neg_conditioning, vae, upscale_method, scale_megapixels, images_base64):
        """
        Process multiple base64 images and chain them as reference latents.

        Args:
            conditioning: Input conditioning to append reference latents to
            neg_conditioning: Input negative conditioning to append reference latents to
            vae: VAE model for encoding images to latents
            upscale_method: Method for scaling images
            scale_megapixels: Target megapixels for image scaling
            images_base64: JSON array of base64-encoded image strings

        Returns:
            Conditioning with all reference latents appended
        """
        # Parse JSON array of base64 strings
        try:
            images_list = json.loads(images_base64)
        except json.JSONDecodeError:
            # If not valid JSON, treat as single base64 string
            images_list = [images_base64] if images_base64.strip() else []

        if not isinstance(images_list, list):
            images_list = [images_list] if images_list else []

        # Filter out empty strings
        images_list = [img for img in images_list if img and isinstance(img, str) and img.strip()]

        # If no images, return conditioning unchanged with empty image
        if not images_list:
            empty_image = torch.zeros((1, 1, 1, 3), dtype=torch.float32)
            return (conditioning, neg_conditioning, empty_image)

        # Process each image
        result_conditioning = conditioning
        result_neg_conditioning = neg_conditioning
        first_scaled_image = None

        for i, base64_data in enumerate(images_list):
            try:
                # Load image from base64
                image_tensor = self.load_image_from_base64(base64_data)

                # Scale to target megapixels
                scaled_image = self.scale_image(image_tensor, upscale_method, scale_megapixels)

                # Store first scaled image for output
                if first_scaled_image is None:
                    first_scaled_image = scaled_image

                # VAE encode
                latent_samples = vae.encode(scaled_image[:, :, :, :3])

                # Append to conditioning using the same method as ReferenceLatent
                result_conditioning = node_helpers.conditioning_set_values(
                    result_conditioning,
                    {"reference_latents": [latent_samples]},
                    append=True
                )
                
                # Append to negative conditioning as well
                result_neg_conditioning = node_helpers.conditioning_set_values(
                    result_neg_conditioning,
                    {"reference_latents": [latent_samples]},
                    append=True
                )
            except Exception as e:
                print(f"[ReferenceChainConditioningBase64] Warning: Failed to process image {i}: {e}")
                continue

        # Ensure we have a first image (fallback to empty if somehow none processed)
        if first_scaled_image is None:
            first_scaled_image = torch.zeros((1, 1, 1, 3), dtype=torch.float32)

        return (result_conditioning, result_neg_conditioning, first_scaled_image)

    @classmethod
    def IS_CHANGED(cls, conditioning, neg_conditioning, vae, upscale_method, scale_megapixels, images_base64):
        """Check if the node needs to be re-executed based on input changes."""
        # Hash the base64 data directly
        m = hashlib.sha256()
        m.update(images_base64.encode('utf-8'))
        return m.digest().hex()
