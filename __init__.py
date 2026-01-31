from .nodes import ReferenceChainConditioning, ReferenceChainConditioningBase64

NODE_CLASS_MAPPINGS = {
    "ReferenceChainConditioning": ReferenceChainConditioning,
    "ReferenceChainConditioningBase64": ReferenceChainConditioningBase64,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ReferenceChainConditioning": "Reference Chain Conditioning",
    "ReferenceChainConditioningBase64": "Reference Chain Conditioning (Base64)",
}

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
