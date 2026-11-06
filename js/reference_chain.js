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
 * Display-only widget for managing a list of images with previews.
 * The list itself lives in the node's hidden "images" STRING widget (valueWidget),
 * which is the widget that gets serialized into workflows and prompts.
 * Styled to match ComfyUI's LoadImage node
 */
class ImageListWidget {
    constructor(node, valueWidget) {
        this.node = node;
        this.name = "images_ui";
        this.type = "custom";
        this.serialize = false;
        this.options = { serialize: false };
        this.valueWidget = valueWidget;

        // Own-property marker: newer frontends re-parent custom widgets, so instanceof can't be used
        this.isReferenceChainList = true;

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

        this.maxImages = Infinity;
    }

    get images() {
        let images;
        try {
            images = JSON.parse(this.valueWidget.value || "[]");
        } catch (e) {
            images = [];
        }
        return Array.isArray(images) ? images.filter((img) => img && typeof img === "string") : [];
    }

    setImages(images) {
        this.valueWidget.value = JSON.stringify(images);
        this.preloadImages();
        this.node.onImageListChanged?.();
        this.updateNodeSize();
    }

    /**
     * Preload images into cache
     */
    preloadImages() {
        for (const filename of this.images) {
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
        const numImages = this.images.length;
        const height = (numImages * this.getSlotHeight()) + DROP_ZONE_HEIGHT + SLOT_PADDING + BUTTON_HEIGHT + SLOT_PADDING * 2;
        return [this.node?.size?.[0] || 200, height];
    }

    /**
     * Add an image to the list
     */
    addImage(filename) {
        const images = this.images;
        if (filename && !images.includes(filename)) {
            if (images.length >= this.maxImages) {
                showWarning(`Only ${this.maxImages} images fit in this node; ${filename} was not added.`);
                return;
            }
            images.push(filename);
            this.setImages(images);
        }
    }

    /**
     * Remove an image from the list
     */
    removeImage(index) {
        const images = this.images;
        if (index >= 0 && index < images.length) {
            const [filename] = images.splice(index, 1);
            this.imageCache.delete(filename);
            this.setImages(images);
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
                if (w.hidden) continue;
                // Standard widget height is ~20-26px, use 26 as safe default
                otherWidgetsHeight += (w.computedHeight || 26) + 4;
            }
        }

        // Input/output slot rows (at least ~70px) + other widgets + this widget's height
        const slotRows = Math.max(this.node.inputs?.length || 0, this.node.outputs?.length || 0);
        const headerSpace = Math.max(70, slotRows * LiteGraph.NODE_SLOT_HEIGHT + 10);
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

        const images = this.images;
        // Covers values restored on workflow load, which bypass setImages
        this.preloadImages();

        ctx.save();

        let currentY = y + SLOT_PADDING;
        const slotHeight = this.getSlotHeight();

        // Store positions for click handling
        this._slotPositions = [];

        // Draw each image slot
        for (let i = 0; i < images.length; i++) {
            const filename = images[i];
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
        const dropZoneY = currentY + images.length * slotHeight + SLOT_PADDING;

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
}

const BANK_MAX_IMAGES = 16;  // matches ReferenceImageBank.MAX_IMAGES in nodes.py

function getImageListWidget(node) {
    return node.widgets?.find((w) => w.isReferenceChainList);
}

function showWarning(detail) {
    app.extensionManager?.toast?.add({ severity: "warn", summary: "ReferenceChain", detail, life: 5000 });
}

/**
 * Keep the "images" STRING widget as the serialized value (same position, so old
 * workflows restore into it) and show a display-only list widget right after it
 */
function addImageList(node) {
    const imagesWidget = node.widgets?.find((w) => w.name === "images");
    if (!imagesWidget) return;
    imagesWidget.hidden = true;

    const listWidget = node.addCustomWidget(new ImageListWidget(node, imagesWidget));
    node.widgets.splice(node.widgets.indexOf(listWidget), 1);
    node.widgets.splice(node.widgets.indexOf(imagesWidget) + 1, 0, listWidget);
    return listWidget;
}

/**
 * Drag and drop and resize-on-load for nodes that carry an image list
 */
function addImageListHandlers(nodeType) {
    // Resize to fit images restored from a saved workflow
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
        const result = onConfigure?.apply(this, arguments);
        getImageListWidget(this)?.updateNodeSize();
        return result;
    };

    const onDragOver = nodeType.prototype.onDragOver;
    nodeType.prototype.onDragOver = function (e) {
        const result = onDragOver?.apply(this, arguments);

        if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();

            // Update drop zone highlight
            const widget = getImageListWidget(this);
            if (widget && !widget.dropZoneActive) {
                widget.dropZoneActive = true;
                this.setDirtyCanvas(true, true);
            }

            return true;
        }

        return result;
    };

    const onDragLeave = nodeType.prototype.onDragLeave;
    nodeType.prototype.onDragLeave = function (e) {
        const result = onDragLeave?.apply(this, arguments);

        // Clear drop zone highlight
        const widget = getImageListWidget(this);
        if (widget?.dropZoneActive) {
            widget.dropZoneActive = false;
            this.setDirtyCanvas(true, true);
        }

        return result;
    };

    const onDragDrop = nodeType.prototype.onDragDrop;
    nodeType.prototype.onDragDrop = async function (e) {
        // Clear drop zone highlight
        const widget = getImageListWidget(this);
        if (widget) {
            widget.dropZoneActive = false;
            this.setDirtyCanvas(true, true);
        }

        if (widget && e.dataTransfer?.files?.length > 0) {
            for (const file of e.dataTransfer.files) {
                if (file.type.startsWith("image/")) {
                    await widget.uploadImage(file);
                }
            }
            return true;
        }

        return onDragDrop?.apply(this, arguments);
    };
}

/**
 * The frontend's document paste handler never calls node.onPaste: it pastes only into
 * nodes it treats as image previews and otherwise creates a LoadImage node. It skips
 * pastes that are already cancelled, so claim image pastes aimed at a selected
 * image-list node first.
 */
async function pasteIntoImageList(e) {
    if (e.defaultPrevented) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target?.isContentEditable) return;

    const node = app.canvas?.current_node;
    const widget = node?.is_selected && getImageListWidget(node);
    if (!widget) return;

    const files = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter(Boolean);
    if (!files.length) return;

    e.preventDefault();
    for (const file of files) {
        await widget.uploadImage(file);
    }
}

/**
 * Show one output per image, always keeping image_1. Outputs past the image count
 * are dropped from the end, so output N keeps carrying bank image N.
 */
function syncBankOutputs(node) {
    const count = Math.max(1, Math.min(getImageListWidget(node)?.images.length ?? 0, BANK_MAX_IMAGES));
    while (node.outputs.length > count) {
        const slot = node.outputs.length - 1;
        node.disconnectOutput(slot);
        node.removeOutput(slot);
    }
    while (node.outputs.length < count) {
        node.addOutput(`image_${node.outputs.length + 1}`, "IMAGE");
    }
}

/**
 * For every autogrow input image_1 feeds, connect the remaining outputs to the
 * group's trailing free slot one at a time. Each connect makes the target grow
 * its next slot, so the outputs land in order.
 */
function wireBankOutputs(node) {
    const graph = node.graph;
    if (!graph) return;

    for (const linkId of node.outputs[0]?.links ?? []) {
        const link = graph.getLink(linkId);
        const target = link && graph.getNodeById(link.target_id);
        const input = target?.inputs?.[link.target_slot];
        if (!input) continue;

        const group = input.name.slice(0, input.name.lastIndexOf("."));
        if (!target.comfyDynamic?.autogrow?.[group]) continue;

        for (let slot = 1; slot < node.outputs.length; slot++) {
            const alreadyLinked = (node.outputs[slot].links ?? []).some(
                (id) => graph.getLink(id)?.target_id === target.id
            );
            if (alreadyLinked) continue;

            const free = target.inputs.findLastIndex((inp) => inp.name.startsWith(group + "."));
            if (free === -1 || target.inputs[free].link != null) {
                showWarning(`${target.title} has no free image slot left; image_${slot + 1} and later were not connected.`);
                break;
            }
            node.connect(slot, target, free);
        }
    }
}

/**
 * Register the extension
 */
app.registerExtension({
    name: "Comfy.ReferenceChain",

    setup() {
        // Capture phase, so this runs before the frontend's own document listener
        document.addEventListener("paste", pasteIntoImageList, true);
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "ReferenceChainConditioning") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);

                addImageList(this)?.updateNodeSize();

                // Remove the default image_input_1 slot (created from optional INPUT_TYPES)
                // since image_input_node_count defaults to 0
                const defaultImageInput = this.inputs?.findIndex(input => input.name === "image_input_1");
                if (defaultImageInput !== undefined && defaultImageInput >= 0) {
                    this.removeInput(defaultImageInput);
                }

                // Add "Update image inputs" button for dynamic IMAGE input slots
                this.addWidget("button", "Update image inputs", null, () => {
                    if (!this.inputs) {
                        this.inputs = [];
                    }
                    const target = this.widgets.find(w => w.name === "image_input_node_count")?.value || 0;
                    const current = this.inputs.filter(input => input.type === "IMAGE").length;
                    if (target === current) return;

                    if (target < current) {
                        // Remove excess IMAGE inputs from the end
                        for (let i = 0; i < current - target; i++) {
                            // Find the last IMAGE input and remove it
                            for (let j = this.inputs.length - 1; j >= 0; j--) {
                                if (this.inputs[j].type === "IMAGE") {
                                    this.removeInput(j);
                                    break;
                                }
                            }
                        }
                    } else {
                        // Add new IMAGE inputs
                        for (let i = current + 1; i <= target; i++) {
                            this.addInput(`image_input_${i}`, "IMAGE", { shape: 7 });
                        }
                    }
                });

                return result;
            };

            addImageListHandlers(nodeType);
        }

        if (nodeData.name === "ReferenceImageBank") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const result = onNodeCreated?.apply(this, arguments);

                const listWidget = addImageList(this);
                if (listWidget) listWidget.maxImages = BANK_MAX_IMAGES;
                syncBankOutputs(this);
                listWidget?.updateNodeSize();

                return result;
            };

            nodeType.prototype.onImageListChanged = function () {
                syncBankOutputs(this);
                wireBankOutputs(this);
            };

            // Wiring image_1 by hand wires the rest of the bank to the same node
            const onConnectionsChange = nodeType.prototype.onConnectionsChange;
            nodeType.prototype.onConnectionsChange = function (type, slot, connected) {
                const result = onConnectionsChange?.apply(this, arguments);
                if (type === LiteGraph.OUTPUT && slot === 0 && connected && !app.configuringGraph) {
                    requestAnimationFrame(() => wireBankOutputs(this));
                }
                return result;
            };

            addImageListHandlers(nodeType);
        }
    },
});
