import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Constants for the image list widget - matching ComfyUI style
const IMAGE_HEIGHT = 200;  // Height for image display area
const BUTTON_HEIGHT = 26;  // Standard ComfyUI button height
const DROP_ZONE_HEIGHT = 78;  // Height for drop zone (3x button height)
const FILENAME_HEIGHT = 20;  // Height for filename display
const DIMENSIONS_HEIGHT = 16;  // Height for dimensions text
const SLOT_PADDING = 8;
const REMOVE_BUTTON_SIZE = 16;

/**
 * Custom widget for managing a list of images with previews
 * Styled to match ComfyUI's LoadImage node
 */
class ImageListWidget {
    constructor(node, inputName, inputData) {
        this.node = node;
        this.name = inputName;
        this.type = "custom";
        this.options = { serialize: true };

        // Array of image filenames
        this._images = [];

        // Cache for loaded image elements with dimensions
        this.imageCache = new Map();

        // Track if we're currently uploading
        this.isUploading = false;

        // Hover state for remove buttons
        this.hoverRemoveIndex = -1;

        // Hover state for add button
        this.hoverAddButton = false;

        // Hover/drag state for drop zone
        this.dropZoneActive = false;

        // Initialize from default value
        try {
            const defaultVal = inputData?.[1]?.default || "[]";
            this._images = JSON.parse(defaultVal);
            if (!Array.isArray(this._images)) {
                this._images = [];
            }
        } catch (e) {
            this._images = [];
        }
    }

    get value() {
        return JSON.stringify(this._images);
    }

    set value(v) {
        try {
            if (typeof v === "string") {
                this._images = JSON.parse(v);
            } else if (Array.isArray(v)) {
                this._images = v;
            } else {
                this._images = [];
            }
        } catch (e) {
            this._images = [];
        }
        if (!Array.isArray(this._images)) {
            this._images = [];
        }

        // Preload images
        this.preloadImages();

        // Request redraw
        if (this.node) {
            this.node.setDirtyCanvas(true, true);
        }
    }

    get images() {
        return this._images;
    }

    /**
     * Preload images into cache
     */
    preloadImages() {
        for (const filename of this._images) {
            if (!this.imageCache.has(filename)) {
                const img = new Image();
                img.src = `/view?filename=${encodeURIComponent(filename)}&type=input`;
                img.onload = () => {
                    // Store with dimensions
                    this.imageCache.set(filename, {
                        img: img,
                        width: img.naturalWidth,
                        height: img.naturalHeight
                    });
                    if (this.node) {
                        this.node.setDirtyCanvas(true, true);
                    }
                };
                // Temporarily store just the image while loading
                this.imageCache.set(filename, { img: img, width: 0, height: 0 });
            }
        }
    }

    /**
     * Calculate slot height for one image entry
     */
    getSlotHeight() {
        return FILENAME_HEIGHT + IMAGE_HEIGHT + DIMENSIONS_HEIGHT + SLOT_PADDING * 2;
    }

    /**
     * Calculate widget height based on number of images
     */
    computeSize() {
        const numImages = this._images.length;
        const height = (numImages * this.getSlotHeight()) + DROP_ZONE_HEIGHT + SLOT_PADDING + BUTTON_HEIGHT + SLOT_PADDING * 2;
        return [this.node?.size?.[0] || 200, height];
    }

    /**
     * Add an image to the list
     */
    addImage(filename) {
        if (filename && !this._images.includes(filename)) {
            this._images.push(filename);
            this.preloadImages();
            this.updateNodeSize();
            this.node?.setDirtyCanvas(true, true);
        }
    }

    /**
     * Remove an image from the list
     */
    removeImage(index) {
        if (index >= 0 && index < this._images.length) {
            const filename = this._images[index];
            this._images.splice(index, 1);
            this.imageCache.delete(filename);
            this.updateNodeSize();
            this.node?.setDirtyCanvas(true, true);
        }
    }

    /**
     * Update node size to fit all images
     */
    updateNodeSize() {
        if (!this.node) return;

        // Calculate height needed for this widget
        const [_, widgetHeight] = this.computeSize();

        // Calculate space taken by other widgets above this one
        let otherWidgetsHeight = 0;
        const widgetIndex = this.node.widgets?.indexOf(this);
        if (widgetIndex > 0) {
            for (let i = 0; i < widgetIndex; i++) {
                const w = this.node.widgets[i];
                // Standard widget height is ~20-26px, use 26 as safe default
                otherWidgetsHeight += (w.computedHeight || 26) + 4;
            }
        }

        // Title bar + header space (~70px) + other widgets + this widget's height
        const headerSpace = 70;
        const idealHeight = headerSpace + otherWidgetsHeight + widgetHeight;
        const minHeight = 200;

        this.node.size[1] = Math.max(minHeight, idealHeight);
        this.node.setDirtyCanvas(true, true);
    }

    /**
     * Upload an image file
     */
    async uploadImage(file) {
        if (this.isUploading) return;
        this.isUploading = true;

        try {
            const formData = new FormData();
            formData.append("image", file);
            formData.append("type", "input");
            formData.append("overwrite", "false");

            const response = await api.fetchApi("/upload/image", {
                method: "POST",
                body: formData,
            });

            if (response.ok) {
                const result = await response.json();
                let filename = result.name;
                if (result.subfolder) {
                    filename = `${result.subfolder}/${result.name}`;
                }
                this.addImage(filename);
            } else {
                console.error("[ReferenceChain] Upload failed:", response.status);
            }
        } catch (e) {
            console.error("[ReferenceChain] Upload error:", e);
        } finally {
            this.isUploading = false;
        }
    }

    /**
     * Open file dialog to select images
     */
    openFileDialog() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.onchange = async (e) => {
            const files = e.target.files;
            for (const file of files) {
                await this.uploadImage(file);
            }
        };
        input.click();
    }

    /**
     * Truncate filename to fit width
     */
    truncateFilename(ctx, filename, maxWidth) {
        const ellipsis = "...";
        let text = filename;

        if (ctx.measureText(text).width <= maxWidth) {
            return text;
        }

        // Try to show end of filename (more useful)
        while (text.length > 0 && ctx.measureText(ellipsis + text).width > maxWidth) {
            text = text.slice(1);
        }

        return ellipsis + text;
    }

    /**
     * Draw the widget - ComfyUI style
     */
    draw(ctx, node, widgetWidth, y, widgetHeight) {
        const margin = 15;
        const x = margin;
        const width = widgetWidth - margin * 2;

        ctx.save();

        let currentY = y + SLOT_PADDING;
        const slotHeight = this.getSlotHeight();

        // Store positions for click handling
        this._slotPositions = [];

        // Draw each image slot
        for (let i = 0; i < this._images.length; i++) {
            const filename = this._images[i];
            const slotY = currentY + i * slotHeight;

            // Get cached image data
            const cached = this.imageCache.get(filename);
            const img = cached?.img;
            const imgWidth = cached?.width || 0;
            const imgHeight = cached?.height || 0;

            // --- Filename bar (like LoadImage combo) ---
            const filenameY = slotY;

            // Background for filename
            ctx.fillStyle = "#232323";
            ctx.beginPath();
            ctx.roundRect(x, filenameY, width, FILENAME_HEIGHT, [4, 4, 0, 0]);
            ctx.fill();

            // Border
            ctx.strokeStyle = "#3a3a3a";
            ctx.lineWidth = 1;
            ctx.stroke();

            // Filename text
            ctx.fillStyle = "#cccccc";
            ctx.font = "11px Arial";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";

            const displayFilename = this.truncateFilename(ctx, filename, width - REMOVE_BUTTON_SIZE - 20);
            ctx.fillText(displayFilename, x + 8, filenameY + FILENAME_HEIGHT / 2);

            // --- Remove button (X) in filename bar ---
            const removeX = x + width - REMOVE_BUTTON_SIZE - 4;
            const removeY = filenameY + (FILENAME_HEIGHT - REMOVE_BUTTON_SIZE) / 2 + 1;

            // Hover highlight
            if (this.hoverRemoveIndex === i) {
                ctx.fillStyle = "#555555";
                ctx.beginPath();
                ctx.roundRect(removeX, removeY, REMOVE_BUTTON_SIZE, REMOVE_BUTTON_SIZE - 2, 2);
                ctx.fill();
            }

            // Draw X
            ctx.strokeStyle = this.hoverRemoveIndex === i ? "#ffffff" : "#888888";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            const xPad = 4;
            ctx.moveTo(removeX + xPad, removeY + xPad);
            ctx.lineTo(removeX + REMOVE_BUTTON_SIZE - xPad, removeY + REMOVE_BUTTON_SIZE - 2 - xPad);
            ctx.moveTo(removeX + REMOVE_BUTTON_SIZE - xPad, removeY + xPad);
            ctx.lineTo(removeX + xPad, removeY + REMOVE_BUTTON_SIZE - 2 - xPad);
            ctx.stroke();

            // --- Image area ---
            const imageY = filenameY + FILENAME_HEIGHT;

            // Image background
            ctx.fillStyle = "#1a1a1a";
            ctx.fillRect(x, imageY, width, IMAGE_HEIGHT);

            // Draw image (fill width, maintain aspect ratio)
            if (img && img.complete && imgWidth > 0) {
                const imgAspect = imgWidth / imgHeight;
                const areaAspect = width / IMAGE_HEIGHT;

                let drawW, drawH, drawX, drawY;

                if (imgAspect > areaAspect) {
                    // Image is wider - fit to width
                    drawW = width;
                    drawH = width / imgAspect;
                    drawX = x;
                    drawY = imageY + (IMAGE_HEIGHT - drawH) / 2;
                } else {
                    // Image is taller - fit to height
                    drawH = IMAGE_HEIGHT;
                    drawW = IMAGE_HEIGHT * imgAspect;
                    drawX = x + (width - drawW) / 2;
                    drawY = imageY;
                }

                ctx.drawImage(img, drawX, drawY, drawW, drawH);
            } else {
                // Loading placeholder
                ctx.fillStyle = "#333333";
                ctx.font = "12px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("Loading...", x + width / 2, imageY + IMAGE_HEIGHT / 2);
            }

            // --- Dimensions text ---
            const dimY = imageY + IMAGE_HEIGHT;

            ctx.fillStyle = "#1a1a1a";
            ctx.beginPath();
            ctx.roundRect(x, dimY, width, DIMENSIONS_HEIGHT, [0, 0, 4, 4]);
            ctx.fill();

            if (imgWidth > 0 && imgHeight > 0) {
                ctx.fillStyle = "#888888";
                ctx.font = "10px Arial";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(`${imgWidth} × ${imgHeight}`, x + width / 2, dimY + DIMENSIONS_HEIGHT / 2);
            }

            // Store slot position for click handling
            this._slotPositions.push({
                y: slotY,
                height: slotHeight,
                filenameY: filenameY,
                filenameHeight: FILENAME_HEIGHT,
                removeX,
                removeY,
                removeSize: REMOVE_BUTTON_SIZE,
            });
        }

        // --- Drop zone area ---
        const dropZoneY = currentY + this._images.length * slotHeight + SLOT_PADDING;

        // Drop zone background
        ctx.fillStyle = this.dropZoneActive ? "#2a2a2a" : "#1a1a1a";
        ctx.beginPath();
        ctx.roundRect(x, dropZoneY, width, DROP_ZONE_HEIGHT, 4);
        ctx.fill();

        // Drop zone dashed border
        ctx.strokeStyle = this.dropZoneActive ? "#666666" : "#444444";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);  // Reset dash

        // Drop zone text
        ctx.fillStyle = this.dropZoneActive ? "#888888" : "#555555";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("drop image here", x + width / 2, dropZoneY + DROP_ZONE_HEIGHT / 2);

        // --- "choose file to upload" button (ComfyUI style) ---
        const buttonY = dropZoneY + DROP_ZONE_HEIGHT + SLOT_PADDING;

        // Button background
        ctx.fillStyle = this.hoverAddButton ? "#3a3a3a" : "#2a2a2a";
        ctx.beginPath();
        ctx.roundRect(x, buttonY, width, BUTTON_HEIGHT, 4);
        ctx.fill();

        // Button border
        ctx.strokeStyle = "#4a4a4a";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Button text
        ctx.fillStyle = "#cccccc";
        ctx.font = "12px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("choose file to upload", x + width / 2, buttonY + BUTTON_HEIGHT / 2);

        ctx.restore();

        // Store positions
        this._dropZoneY = dropZoneY;
        this._dropZoneHeight = DROP_ZONE_HEIGHT;
        this._buttonY = buttonY;
        this._buttonHeight = BUTTON_HEIGHT;
        this._x = x;
        this._width = width;
    }

    /**
     * Handle mouse events
     */
    mouse(event, pos, node) {
        const [mouseX, mouseY] = pos;

        if (event.type === "pointermove") {
            // Update hover state for remove buttons
            let newHoverIndex = -1;
            if (this._slotPositions) {
                for (let i = 0; i < this._slotPositions.length; i++) {
                    const slot = this._slotPositions[i];
                    if (
                        mouseX >= slot.removeX &&
                        mouseX <= slot.removeX + slot.removeSize &&
                        mouseY >= slot.removeY &&
                        mouseY <= slot.removeY + slot.removeSize
                    ) {
                        newHoverIndex = i;
                        break;
                    }
                }
            }

            // Update hover state for add button
            const newHoverAddButton = (
                this._buttonY !== undefined &&
                mouseX >= this._x &&
                mouseX <= this._x + this._width &&
                mouseY >= this._buttonY &&
                mouseY <= this._buttonY + this._buttonHeight
            );

            if (newHoverIndex !== this.hoverRemoveIndex || newHoverAddButton !== this.hoverAddButton) {
                this.hoverRemoveIndex = newHoverIndex;
                this.hoverAddButton = newHoverAddButton;
                node.setDirtyCanvas(true, true);
            }
            return false;
        }

        if (event.type === "pointerdown") {
            // Check if clicked on a remove button
            if (this._slotPositions) {
                for (let i = 0; i < this._slotPositions.length; i++) {
                    const slot = this._slotPositions[i];
                    if (
                        mouseX >= slot.removeX &&
                        mouseX <= slot.removeX + slot.removeSize &&
                        mouseY >= slot.removeY &&
                        mouseY <= slot.removeY + slot.removeSize
                    ) {
                        this.removeImage(i);
                        return true;
                    }
                }
            }

            // Check if clicked on add button
            if (
                this._buttonY !== undefined &&
                mouseX >= this._x &&
                mouseX <= this._x + this._width &&
                mouseY >= this._buttonY &&
                mouseY <= this._buttonY + this._buttonHeight
            ) {
                this.openFileDialog();
                return true;
            }
        }

        return false;
    }

    /**
     * Serialize widget value
     */
    serializeValue() {
        return this.value;
    }
}

/**
 * Register the extension
 */
app.registerExtension({
    name: "Comfy.ReferenceChain",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ReferenceChainConditioning") {
            return;
        }

        // Store original onNodeCreated
        const onNodeCreated = nodeType.prototype.onNodeCreated;

        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);

            // Find the images widget and replace it
            const imagesWidget = this.widgets?.find((w) => w.name === "images");
            if (imagesWidget) {
                // Get index
                const index = this.widgets.indexOf(imagesWidget);

                // Create custom widget
                const customWidget = new ImageListWidget(
                    this,
                    "images",
                    nodeData.input?.required?.images
                );

                // Replace widget
                this.widgets[index] = customWidget;

                // Initialize size
                customWidget.updateNodeSize();
            }

            return result;
        };

        // Handle drag and drop
        const onDragOver = nodeType.prototype.onDragOver;
        nodeType.prototype.onDragOver = function (e) {
            const result = onDragOver?.apply(this, arguments);

            if (e.dataTransfer?.types?.includes("Files")) {
                e.preventDefault();

                // Update drop zone highlight
                const widget = this.widgets?.find((w) => w.name === "images");
                if (widget && widget instanceof ImageListWidget) {
                    if (!widget.dropZoneActive) {
                        widget.dropZoneActive = true;
                        this.setDirtyCanvas(true, true);
                    }
                }

                return true;
            }

            return result;
        };

        const onDragLeave = nodeType.prototype.onDragLeave;
        nodeType.prototype.onDragLeave = function (e) {
            const result = onDragLeave?.apply(this, arguments);

            // Clear drop zone highlight
            const widget = this.widgets?.find((w) => w.name === "images");
            if (widget && widget instanceof ImageListWidget) {
                if (widget.dropZoneActive) {
                    widget.dropZoneActive = false;
                    this.setDirtyCanvas(true, true);
                }
            }

            return result;
        };

        const onDragDrop = nodeType.prototype.onDragDrop;
        nodeType.prototype.onDragDrop = async function (e) {
            // Clear drop zone highlight
            const widget = this.widgets?.find((w) => w.name === "images");
            if (widget && widget instanceof ImageListWidget) {
                widget.dropZoneActive = false;
                this.setDirtyCanvas(true, true);
            }

            if (e.dataTransfer?.files?.length > 0) {
                if (widget && widget instanceof ImageListWidget) {
                    for (const file of e.dataTransfer.files) {
                        if (file.type.startsWith("image/")) {
                            await widget.uploadImage(file);
                        }
                    }
                    return true;
                }
            }

            return onDragDrop?.apply(this, arguments);
        };

        // Handle paste
        const onPaste = nodeType.prototype.onPaste;
        nodeType.prototype.onPaste = async function (e) {
            const widget = this.widgets?.find((w) => w.name === "images");
            if (widget && widget instanceof ImageListWidget) {
                const items = e.clipboardData?.items;
                if (items) {
                    for (const item of items) {
                        if (item.type.startsWith("image/")) {
                            const file = item.getAsFile();
                            if (file) {
                                await widget.uploadImage(file);
                                return true;
                            }
                        }
                    }
                }
            }

            return onPaste?.apply(this, arguments);
        };
    },
});
