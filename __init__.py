from .nodes import ReferenceChainConditioning, ReferenceChainConditioningBase64, ReferenceImageBank

NODE_CLASS_MAPPINGS = {
    "ReferenceChainConditioning": ReferenceChainConditioning,
    "ReferenceChainConditioningBase64": ReferenceChainConditioningBase64,
    "ReferenceImageBank": ReferenceImageBank,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ReferenceChainConditioning": "Reference Chain Conditioning",
    "ReferenceChainConditioningBase64": "Reference Chain Conditioning (Base64)",
    "ReferenceImageBank": "Reference Image Bank",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
