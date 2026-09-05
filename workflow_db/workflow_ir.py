"""Canonical ComfyUI workflow semantic graph IR.

ComfyUI workflows are directed graphs rather than trees.  A link is therefore
kept as a first-class semantic object: its output slot, target input field,
declared type, polarity and evidence source can all change how an otherwise
identical node is interpreted.

The IR is deliberately additive.  It preserves the raw API prompt and UI
workflow objects and exposes the small ``WorkflowGraph`` query surface used by
the frozen record parser.  Consumers may progressively adopt the richer node
and edge views without changing record output semantics.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Iterable, Mapping


def normalize_link(value: Any) -> tuple[str, int] | None:
    """Normalize a ComfyUI API link while rejecting booleans and bad slots."""
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    node_id, output_slot = value[0], value[1]
    if isinstance(node_id, bool) or not isinstance(node_id, (str, int)):
        return None
    if isinstance(output_slot, bool):
        return None
    try:
        return str(node_id), int(output_slot)
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True, slots=True)
class LiteralExpr:
    """A literal node input.  ``value`` is preserved without coercion."""

    value: Any


@dataclass(frozen=True, slots=True)
class LinkExpr:
    """A node input whose value is an upstream node/output reference."""

    source_node_id: str
    source_slot: int
    raw_value: Any


InputExpr = LiteralExpr | LinkExpr


@dataclass(frozen=True, slots=True)
class NodePort:
    node_id: str
    slot: int


@dataclass(frozen=True, slots=True)
class InputPort:
    node_id: str
    field: str
    slot: int | None = None


@dataclass(frozen=True, slots=True)
class OutputDerivation:
    """Static relation between one output slot and node inputs/parameters."""

    output_slot: int
    kind: str
    input_fields: tuple[str, ...] = ()
    expression: str | None = None


@dataclass(frozen=True, slots=True)
class NodeBehavior:
    """Bounded semantic contract for a node implementation.

    ``opaque`` is the safe default. A node is transparent only when a proven
    output derivation maps its output directly to an input without mutation.
    """

    operation: str = "opaque"
    output_derivations: tuple[OutputDerivation, ...] = ()
    side_effects: tuple[str, ...] = ()
    determinism: str = "unknown"
    batch_behavior: str = "unknown"
    transparent: bool = False
    provenance: str = "unavailable"
    confidence: str = "unknown"

    def path_effect(self, output_slot: int) -> str:
        matches = tuple(
            item for item in self.output_derivations
            if item.output_slot == output_slot
        )
        if (
            self.transparent
            and len(matches) == 1
            and matches[0].kind == "input"
            and len(matches[0].input_fields) == 1
        ):
            return "identity"
        if self.operation == "opaque" or not matches:
            return "opaque"
        return "transformed"


@dataclass(frozen=True, slots=True)
class NodeDefinitionView:
    """Consensus definition attached to an encountered workflow node."""

    status: str = "missing"
    definition_ids: tuple[str, ...] = ()
    input_types: tuple[tuple[str, str | None], ...] = ()
    output_types: tuple[str | None, ...] = ()
    resolved_levels: tuple[str, ...] = ()


_MISSING_DEFINITION = NodeDefinitionView()
_MISSING_BEHAVIOR = NodeBehavior(provenance="unavailable", confidence="none")
_DEFINITION_ONLY_BEHAVIOR = NodeBehavior(
    provenance="definition_only", confidence="none"
)


@dataclass(frozen=True, slots=True)
class RawEdge:
    """Lossless API-prompt edge before semantic annotation."""

    edge_id: str
    source: NodePort
    target: InputPort
    raw_value: Any


@dataclass(frozen=True, slots=True)
class SemanticEdge:
    """A raw edge annotated with ComfyUI path semantics and provenance."""

    edge_id: str
    source: NodePort
    target: InputPort
    declared_type: str | None
    kind: str
    polarity: str | None
    branch: str
    provenance: str
    confidence: str
    source_operation: str
    path_effect: str
    behavior_provenance: str
    behavior_confidence: str
    source_bypassed: bool | None
    target_bypassed: bool | None


@dataclass(frozen=True, slots=True)
class AstNode:
    """Canonical node view; input expressions retain links as links."""

    node_id: str
    class_type: str
    inputs: Mapping[str, InputExpr]
    raw_node: Mapping[str, Any]
    workflow_node: Mapping[str, Any] | None
    bypassed: bool | None
    definition: NodeDefinitionView
    behavior: NodeBehavior
    origin: str = "api_prompt"


@dataclass(frozen=True, slots=True)
class _UiLink:
    origin_id: str
    origin_slot: int
    target_id: str
    target_slot: int | None
    target_field: str | None
    declared_type: str | None


class NodeDefinitionRegistry:
    """Read-only view over offline node-definition audit artifacts.

    Multiple repositories may define the same ``class_type``.  Runtime graphs
    normally do not carry repository provenance, so a type is returned only
    when every extracted definition agrees.  Conflicts remain unknown instead
    of selecting an arbitrary repository.
    """

    def __init__(
        self,
        definitions: Iterable[Mapping[str, Any]] = (),
        selected_definition_ids: Mapping[str, str] | None = None,
    ) -> None:
        grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
        for definition in definitions:
            class_type = definition.get("class_type")
            if not class_type:
                continue
            grouped[str(class_type)].append(definition)
        selected_definition_ids = selected_definition_ids or {}
        for class_type, selected_id in selected_definition_ids.items():
            matches = [
                item for item in grouped.get(str(class_type), ())
                if str(item.get("definition_id") or "") == str(selected_id)
            ]
            if matches:
                grouped[str(class_type)] = matches
        self._definitions = {
            class_type: tuple(items) for class_type, items in grouped.items()
        }
        self._behavior_cache: dict[str, NodeBehavior] = {}
        self._definition_cache: dict[str, NodeDefinitionView] = {}

    @classmethod
    def from_artifact(
        cls,
        artifact: Mapping[str, Any] | None,
        selected_definition_ids: Mapping[str, str] | None = None,
    ) -> "NodeDefinitionRegistry":
        if not isinstance(artifact, Mapping):
            return cls(selected_definition_ids=selected_definition_ids)
        definitions = artifact.get("definitions")
        if isinstance(definitions, Mapping):
            normalized = []
            for definition_id, raw in definitions.items():
                if not isinstance(raw, Mapping):
                    continue
                item = dict(raw)
                item.setdefault("definition_id", str(definition_id))
                if "class_type" not in item:
                    item["class_type"] = str(definition_id).split("::", 1)[-1]
                normalized.append(item)
            return cls(normalized, selected_definition_ids=selected_definition_ids)
        records = artifact.get("records")
        if isinstance(records, Mapping):
            return cls(
                [
                    {**raw, "class_type": class_type}
                    for class_type, raw in records.items()
                    if isinstance(raw, Mapping)
                ],
                selected_definition_ids=selected_definition_ids,
            )
        return cls(selected_definition_ids=selected_definition_ids)

    def definitions_for(self, class_type: str) -> tuple[Mapping[str, Any], ...]:
        return self._definitions.get(class_type, ())

    def input_type(self, class_type: str, field_name: str) -> str | None:
        candidates: set[str] = set()
        for definition in self.definitions_for(class_type):
            inputs = definition.get("inputs")
            if not isinstance(inputs, Mapping):
                continue
            for section in inputs.values():
                if not isinstance(section, Mapping):
                    continue
                value = section.get(field_name)
                if isinstance(value, str) and value:
                    candidates.add(value)
        return next(iter(candidates)) if len(candidates) == 1 else None

    def output_type(self, class_type: str, slot: int) -> str | None:
        candidates: set[str] = set()
        for definition in self.definitions_for(class_type):
            values = definition.get("return_types")
            if not isinstance(values, (list, tuple)) or not 0 <= slot < len(values):
                continue
            value = values[slot]
            if isinstance(value, str) and value:
                candidates.add(value)
        return next(iter(candidates)) if len(candidates) == 1 else None

    @staticmethod
    def _behavior_from_definition(definition: Mapping[str, Any]) -> NodeBehavior | None:
        raw = definition.get("semantic")
        if not isinstance(raw, Mapping):
            return None
        derivations = []
        for item in raw.get("output_derivations") or ():
            if not isinstance(item, Mapping):
                continue
            try:
                slot = int(item.get("output_slot"))
            except (TypeError, ValueError):
                continue
            fields = item.get("input_fields") or ()
            derivations.append(OutputDerivation(
                output_slot=slot,
                kind=str(item.get("kind") or "opaque"),
                input_fields=tuple(str(field) for field in fields),
                expression=(
                    str(item["expression"])
                    if item.get("expression") is not None else None
                ),
            ))
        return NodeBehavior(
            operation=str(raw.get("operation") or "opaque"),
            output_derivations=tuple(derivations),
            side_effects=tuple(str(item) for item in raw.get("side_effects") or ()),
            determinism=str(raw.get("determinism") or "unknown"),
            batch_behavior=str(raw.get("batch_behavior") or "unknown"),
            transparent=raw.get("transparent") is True,
            provenance=str(raw.get("provenance") or "static_ast"),
            confidence=str(raw.get("confidence") or "unknown"),
        )

    def behavior(self, class_type: str) -> NodeBehavior:
        """Return a behavior only when all colliding definitions agree."""
        cached = self._behavior_cache.get(class_type)
        if cached is not None:
            return cached
        definitions = self.definitions_for(class_type)
        candidates = tuple(
            behavior for behavior in (
                self._behavior_from_definition(definition)
                for definition in definitions
            )
            if behavior is not None
        )
        if not candidates:
            result = (
                _DEFINITION_ONLY_BEHAVIOR if definitions else _MISSING_BEHAVIOR
            )
        else:
            first = candidates[0]
            result = first
        if candidates and (len(candidates) != len(definitions) or any(
            candidate != first for candidate in candidates[1:]
        )):
            result = NodeBehavior(
                provenance="definition_conflict",
                confidence="conflicting",
            )
        self._behavior_cache[class_type] = result
        return result

    def definition_view(self, class_type: str) -> NodeDefinitionView:
        cached = self._definition_cache.get(class_type)
        if cached is not None:
            return cached
        definitions = self.definitions_for(class_type)
        if not definitions:
            self._definition_cache[class_type] = _MISSING_DEFINITION
            return _MISSING_DEFINITION
        definition_ids = tuple(sorted(
            str(item.get("definition_id") or (
                f"{item.get('repo')}::{class_type}" if item.get("repo") else class_type
            ))
            for item in definitions
        ))
        input_fields = sorted({
            str(field)
            for definition in definitions
            for section in (definition.get("inputs") or {}).values()
            if isinstance(section, Mapping)
            for field in section
        })
        output_count = max(
            (len(item.get("return_types") or ()) for item in definitions),
            default=0,
        )
        signatures = {
            (
                tuple(sorted(
                    (str(section_name), tuple(sorted(
                        (str(field), str(value) if value is not None else None)
                        for field, value in section.items()
                    )))
                    for section_name, section in (item.get("inputs") or {}).items()
                    if isinstance(section, Mapping)
                )),
                tuple(item.get("return_types") or ()),
            )
            for item in definitions
        }
        levels = tuple(sorted({
            str(item.get("resolved_level") or "unknown") for item in definitions
        }))
        if len(signatures) > 1:
            status = "conflict"
        elif levels == ("full",):
            status = "full"
        elif any(level in {"full", "fields_only"} for level in levels):
            status = "partial"
        else:
            status = "unresolved"
        result = NodeDefinitionView(
            status=status,
            definition_ids=definition_ids,
            input_types=tuple(
                (field, self.input_type(class_type, field)) for field in input_fields
            ),
            output_types=tuple(
                self.output_type(class_type, slot) for slot in range(output_count)
            ),
            resolved_levels=levels,
        )
        self._definition_cache[class_type] = result
        return result


_FIELD_KINDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("model", ("model", "model_bundle", "model_")),
    ("positive", ("positive", "pos")),
    ("negative", ("negative", "neg")),
    ("latent", ("latent", "latent_image", "latents", "source_latent")),
    ("image", ("image", "images", "input_image", "source_image")),
    ("mask", ("mask", "masks")),
    ("clip", ("clip", "clip_vision")),
    ("conditioning", ("conditioning", "cond", "base_prompt", "regions")),
    ("vae", ("vae", "vae_")),
    ("controlnet", ("control_net", "controlnet")),
    ("seed", ("seed", "noise_seed")),
    ("sampler", ("sampler",)),
    ("sigmas", ("sigmas",)),
    ("guider", ("guider",)),
)

_TYPE_KINDS = {
    "MODEL": "model",
    "CONDITIONING": "conditioning",
    "LATENT": "latent",
    "IMAGE": "image",
    "MASK": "mask",
    "CLIP": "clip",
    "CLIP_VISION": "clip",
    "VAE": "vae",
    "CONTROL_NET": "controlnet",
    "SAMPLER": "sampler",
    "SIGMAS": "sigmas",
    "GUIDER": "guider",
}


def classify_edge_kind(field_name: str, declared_type: str | None = None) -> str:
    """Classify an edge with target-port semantics taking precedence.

    ``positive`` and ``negative`` deliberately remain distinct kinds even
    though both normally carry ``CONDITIONING`` values.
    """
    normalized = field_name.casefold()
    for kind, keys in _FIELD_KINDS:
        if any(
            normalized == key
            or (key.endswith("_") and normalized.startswith(key))
            for key in keys
        ):
            return kind
    if isinstance(declared_type, str):
        return _TYPE_KINDS.get(declared_type.upper(), "other")
    return "other"


def edge_polarity(field_name: str, kind: str) -> str | None:
    normalized = field_name.casefold()
    if kind == "positive" or normalized in {"positive", "pos"}:
        return "positive"
    if kind == "negative" or normalized in {"negative", "neg"}:
        return "negative"
    return None


class WorkflowIR:
    """Graph-backed AST for API prompt and optional UI workflow metadata."""

    def __init__(
        self,
        prompt: Mapping[str | int, Any] | None,
        workflow: Mapping[str, Any] | None = None,
        registry: NodeDefinitionRegistry | None = None,
    ) -> None:
        self.prompt: dict[str, Any] = {
            str(node_id): node for node_id, node in (prompt or {}).items()
        }
        self.workflow: dict[str, Any] | None = (
            dict(workflow) if isinstance(workflow, Mapping) else None
        )
        self.registry = registry or NodeDefinitionRegistry()
        self._workflow_nodes = self._index_workflow_nodes()
        self._ui_links = self._collect_ui_links()
        self._ui_link_index: dict[tuple[str, int, str], tuple[_UiLink, ...]] = {}
        indexed_links: dict[tuple[str, int, str], list[_UiLink]] = defaultdict(list)
        for link in self._ui_links:
            indexed_links[(link.origin_id, link.origin_slot, link.target_id)].append(link)
        self._ui_link_index = {
            key: tuple(values) for key, values in indexed_links.items()
        }
        self.nodes: dict[str, AstNode] = {}
        self.raw_edges: tuple[RawEdge, ...] = ()
        self.semantic_edges: tuple[SemanticEdge, ...] = ()
        self._incoming: dict[str, list[SemanticEdge]] = defaultdict(list)
        self._outgoing: dict[str, list[SemanticEdge]] = defaultdict(list)
        self._build()

    def node(self, node_id: str | int | None) -> dict[str, Any] | None:
        if node_id is None:
            return None
        node = self.prompt.get(str(node_id))
        return node if isinstance(node, dict) else None

    def node_inputs(self, node_id: str | int | None) -> dict[str, Any]:
        node = self.node(node_id)
        inputs = node.get("inputs", {}) if node else {}
        return inputs if isinstance(inputs, dict) else {}

    def node_type(self, node_id: str | int | None) -> str:
        node = self.node(node_id)
        return str(node.get("class_type", "")) if node else ""

    def workflow_node(self, node_id: str | int | None) -> dict[str, Any] | None:
        if node_id is None:
            return None
        return self._workflow_nodes.get(str(node_id))

    def node_is_bypassed(self, node_id: str | int | None) -> bool:
        workflow_node = self.workflow_node(node_id)
        if not workflow_node:
            return False
        flags = workflow_node.get("flags", {})
        flags = flags if isinstance(flags, dict) else {}
        return bool(
            flags.get("bypassed")
            or flags.get("disabled")
            or workflow_node.get("mode") in {2, 4}
        )

    def incoming_edges(
        self, node_id: str | int, field_name: str | None = None
    ) -> tuple[SemanticEdge, ...]:
        edges = self._incoming.get(str(node_id), ())
        if field_name is None:
            return tuple(edges)
        return tuple(edge for edge in edges if edge.target.field == field_name)

    def outgoing_edges(self, node_id: str | int) -> tuple[SemanticEdge, ...]:
        return tuple(self._outgoing.get(str(node_id), ()))

    def _index_workflow_nodes(self) -> dict[str, dict[str, Any]]:
        if not isinstance(self.workflow, dict):
            return {}
        raw_nodes = self.workflow.get("nodes", [])
        if not isinstance(raw_nodes, list):
            return {}
        return {
            str(node.get("id")): node
            for node in raw_nodes
            if isinstance(node, dict) and node.get("id") is not None
        }

    def _workflow_input_name(self, node_id: str, slot: int | None) -> str | None:
        if slot is None:
            return None
        node = self._workflow_nodes.get(node_id)
        inputs = node.get("inputs", []) if node else []
        if not isinstance(inputs, list) or not 0 <= slot < len(inputs):
            return None
        item = inputs[slot]
        if not isinstance(item, dict) or not item.get("name"):
            return None
        return str(item["name"])

    def _collect_ui_links(self) -> tuple[_UiLink, ...]:
        if not isinstance(self.workflow, dict):
            return ()
        raw_links = self.workflow.get("links", [])
        if not isinstance(raw_links, list):
            return ()
        links: list[_UiLink] = []
        for raw in raw_links:
            if isinstance(raw, dict):
                origin_id = raw.get("origin_id")
                origin_slot = raw.get("origin_slot")
                target_id = raw.get("target_id")
                target_slot = raw.get("target_slot")
                declared_type = raw.get("type")
            elif isinstance(raw, (list, tuple)) and len(raw) >= 6:
                origin_id, origin_slot = raw[1], raw[2]
                target_id, target_slot = raw[3], raw[4]
                declared_type = raw[5]
            else:
                continue
            if any(isinstance(value, bool) for value in (origin_id, origin_slot, target_id)):
                continue
            try:
                normalized_target_slot = (
                    int(target_slot) if target_slot is not None and not isinstance(target_slot, bool) else None
                )
                links.append(
                    _UiLink(
                        origin_id=str(origin_id),
                        origin_slot=int(origin_slot),
                        target_id=str(target_id),
                        target_slot=normalized_target_slot,
                        target_field=self._workflow_input_name(
                            str(target_id), normalized_target_slot
                        ),
                        declared_type=(
                            str(declared_type) if declared_type not in (None, "") else None
                        ),
                    )
                )
            except (TypeError, ValueError):
                continue
        return tuple(links)

    def _match_ui_link(
        self, source_id: str, source_slot: int, target_id: str, target_field: str
    ) -> _UiLink | None:
        candidates = self._ui_link_index.get(
            (source_id, source_slot, target_id), ()
        )
        exact = [link for link in candidates if link.target_field == target_field]
        if len(exact) == 1:
            return exact[0]
        return candidates[0] if len(candidates) == 1 else None

    def _declared_type(
        self,
        source_id: str,
        source_slot: int,
        target_id: str,
        target_field: str,
        ui_link: _UiLink | None,
    ) -> tuple[str | None, str, str]:
        if ui_link and ui_link.declared_type:
            return ui_link.declared_type, "ui_workflow", "authoritative"
        target_type = self.registry.input_type(self.node_type(target_id), target_field)
        source_type = self.registry.output_type(self.node_type(source_id), source_slot)
        if target_type and source_type and target_type == source_type:
            return target_type, "node_registry", "declared_consensus"
        if target_type:
            return target_type, "node_registry", "declared_input"
        if source_type:
            return source_type, "node_registry", "declared_output"
        return None, "api_prompt", "inferred"

    def _build(self) -> None:
        raw_edges: list[RawEdge] = []
        semantic_edges: list[SemanticEdge] = []
        for node_id, raw_node in self.prompt.items():
            if not isinstance(raw_node, dict):
                continue
            class_type = str(raw_node.get("class_type", ""))
            raw_inputs = raw_node.get("inputs", {})
            raw_inputs = raw_inputs if isinstance(raw_inputs, dict) else {}
            expressions: dict[str, InputExpr] = {}
            for field_name, raw_value in raw_inputs.items():
                field_name = str(field_name)
                normalized = normalize_link(raw_value)
                if normalized is None:
                    expressions[field_name] = LiteralExpr(raw_value)
                    continue
                source_id, source_slot = normalized
                expressions[field_name] = LinkExpr(source_id, source_slot, raw_value)
                edge_id = f"{source_id}:{source_slot}->{node_id}:{field_name}"
                ui_link = self._match_ui_link(
                    source_id, source_slot, node_id, field_name
                )
                target_slot = ui_link.target_slot if ui_link else None
                source = NodePort(source_id, source_slot)
                target = InputPort(node_id, field_name, target_slot)
                raw_edge = RawEdge(edge_id, source, target, raw_value)
                raw_edges.append(raw_edge)
                declared_type, provenance, confidence = self._declared_type(
                    source_id, source_slot, node_id, field_name, ui_link
                )
                kind = classify_edge_kind(field_name, declared_type)
                source_behavior = self.registry.behavior(self.node_type(source_id))
                semantic = SemanticEdge(
                    edge_id=edge_id,
                    source=source,
                    target=target,
                    declared_type=declared_type,
                    kind=kind,
                    polarity=edge_polarity(field_name, kind),
                    branch=field_name,
                    provenance=provenance,
                    confidence=confidence,
                    source_operation=source_behavior.operation,
                    path_effect=source_behavior.path_effect(source_slot),
                    behavior_provenance=source_behavior.provenance,
                    behavior_confidence=source_behavior.confidence,
                    source_bypassed=(
                        self.node_is_bypassed(source_id)
                        if self.workflow_node(source_id) is not None
                        else None
                    ),
                    target_bypassed=(
                        self.node_is_bypassed(node_id)
                        if self.workflow_node(node_id) is not None
                        else None
                    ),
                )
                semantic_edges.append(semantic)
                self._incoming[node_id].append(semantic)
                self._outgoing[source_id].append(semantic)
            workflow_node = self.workflow_node(node_id)
            behavior = self.registry.behavior(class_type)
            definition = self.registry.definition_view(class_type)
            self.nodes[node_id] = AstNode(
                node_id=node_id,
                class_type=class_type,
                inputs=MappingProxyType(expressions),
                raw_node=MappingProxyType(raw_node),
                workflow_node=(MappingProxyType(workflow_node) if workflow_node else None),
                bypassed=(
                    self.node_is_bypassed(node_id) if workflow_node is not None else None
                ),
                definition=definition,
                behavior=behavior,
            )
        self.raw_edges = tuple(raw_edges)
        self.semantic_edges = tuple(semantic_edges)


# User-facing terminology can use AST while implementation remains graph-backed.
WorkflowAST = WorkflowIR


__all__ = [
    "AstNode",
    "InputExpr",
    "InputPort",
    "LinkExpr",
    "LiteralExpr",
    "NodeDefinitionRegistry",
    "NodeDefinitionView",
    "NodeBehavior",
    "NodePort",
    "OutputDerivation",
    "RawEdge",
    "SemanticEdge",
    "WorkflowAST",
    "WorkflowIR",
    "classify_edge_kind",
    "edge_polarity",
    "normalize_link",
]
