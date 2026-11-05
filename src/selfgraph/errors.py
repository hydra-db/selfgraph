from __future__ import annotations

__all__ = [
    "SelfGraphError",
    "ValidationError",
    "NotFoundError",
    "ConflictError",
    "ExtractionError",
    "PromptTemplateError",
    "StoreError",
    "TransientError",
]


class SelfGraphError(Exception):
    pass


class ValidationError(SelfGraphError):
    pass


class NotFoundError(SelfGraphError):
    def __init__(self, object_type: str, object_id: str) -> None:
        self.object_type = object_type
        self.object_id = object_id
        super().__init__(f"{object_type} {object_id!r} does not exist")


class ConflictError(SelfGraphError):
    def __init__(self, object_type: str, object_id: str) -> None:
        self.object_type = object_type
        self.object_id = object_id
        super().__init__(f"{object_type} {object_id!r} already exists")


class ExtractionError(SelfGraphError):
    pass


class PromptTemplateError(SelfGraphError):
    pass


class StoreError(SelfGraphError):
    pass


class TransientError(StoreError):
    pass
