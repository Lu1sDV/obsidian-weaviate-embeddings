import { edgesAboveCutoff, type GraphEdge, type SimilarityGraphData } from "./graph";

export interface GraphSelection { noteIds: string[]; cosine?: number; comparison?: string }
const SVG_NS = "http://www.w3.org/2000/svg";

/** A static SVG: cutoff and selection never run retrieval or change node membership. */
export class SimilarityGraph {
  private data: SimilarityGraphData = { nodes: [], edges: [] };
  private selected: GraphSelection = { noteIds: [] };
  private readonly svg: SVGSVGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly count: HTMLElement;
  private cutoff: number;
  private readonly legend: HTMLElement;
  private readonly nodeElements = new Map<string, SVGGElement>();
  private edgeElements: Array<{ edge: GraphEdge; element: SVGLineElement }> = [];

  constructor(private readonly parent: HTMLElement, private readonly select: (selection: GraphSelection) => void, private readonly current: () => boolean, cutoff: number) {
    this.cutoff = cutoff;
    parent.addClass("local-semantic-graph");
    parent.hidden = true;
    const heading = parent.createDiv({ cls: "local-semantic-graph-heading" });
    heading.createEl("h3", { text: "Note similarity" });
    this.count = heading.createSpan();
    this.svg = parent.ownerDocument.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("viewBox", "0 0 360 280");
    this.svg.setAttribute("role", "group");
    this.svg.setAttribute("aria-label", "Schematic note cosine graph. Positions are not semantic distances.");
    this.svg.classList.add("local-semantic-graph-svg");
    this.edgeLayer = parent.ownerDocument.createElementNS(SVG_NS, "g");
    this.nodeLayer = parent.ownerDocument.createElementNS(SVG_NS, "g");
    this.svg.append(this.edgeLayer, this.nodeLayer);
    parent.append(this.svg);
    this.legend = parent.createDiv({ cls: "local-semantic-graph-legend" });
  }

  clear(): void {
    this.data = { nodes: [], edges: [] };
    this.selected = { noteIds: [] };
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.nodeElements.clear();
    this.edgeElements = [];
    this.parent.hidden = true;
    this.count.setText("");
    this.legend.setText("");
  }

  setData(data: SimilarityGraphData): void {
    if (!this.current()) return;
    this.data = data;
    this.selected = { noteIds: [] };
    this.parent.hidden = data.nodes.length === 0;
    const anchor = data.nodes.find((node) => node.anchor);
    this.parent.classList.toggle("is-connections", anchor !== undefined);
    const anchorCosines = new Map<string, number>();
    if (anchor) {
      for (const edge of data.edges) anchorCosines.set(edge.source === anchor.noteId ? edge.target : edge.source, edge.cosine);
    }
    this.nodeElements.clear();
    this.nodeLayer.replaceChildren();
    for (const node of data.nodes) {
      const group = this.svg.ownerDocument.createElementNS(SVG_NS, "g");
      group.setAttribute("transform", `translate(${node.x},${node.y})`);
      group.setAttribute("tabindex", "0");
      group.setAttribute("role", "button");
      const cosine = anchorCosines.get(node.noteId);
      group.setAttribute("aria-label", `${node.anchor ? "Reference" : `Rank ${node.rank}`}: ${node.title}${cosine === undefined ? "" : `. Cosine ${cosine.toFixed(2)}`}. Inspect passages`);
      group.classList.add("local-semantic-graph-node");
      group.classList.toggle("is-anchor", node.anchor);
      const circle = this.svg.ownerDocument.createElementNS(SVG_NS, "circle");
      circle.setAttribute("r", anchor ? node.anchor ? "11" : "7" : "12");
      const title = this.svg.ownerDocument.createElementNS(SVG_NS, "title");
      title.textContent = node.title;
      group.append(circle, title);
      const choose = () => this.choose({ noteIds: [node.noteId] });
      group.addEventListener("click", choose);
      group.addEventListener("focus", choose);
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
        const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (direction) {
          event.preventDefault();
          const index = data.nodes.indexOf(node);
          this.nodeElements.get(data.nodes[(index + direction + data.nodes.length) % data.nodes.length]!.noteId)?.focus();
        }
      });
      this.nodeLayer.append(group);
      this.nodeElements.set(node.noteId, group);
    }
    this.renderEdges();
    this.legend.setText("");
  }

  highlight(noteId: string): void { this.choose({ noteIds: [noteId] }, false); }

  setCutoff(cutoff: number): void {
    this.cutoff = cutoff;
    if (!this.current()) return;
    this.renderEdges();
    if (this.selected.noteIds.length === 2 && this.selected.cosine !== undefined && this.selected.cosine < cutoff) this.choose({ noteIds: [] });
  }

  private renderEdges(): void {
    if (!this.current()) return;
    this.edgeLayer.replaceChildren();
    this.edgeElements = [];
    const positions = new Map(this.data.nodes.map((node) => [node.noteId, node]));
    const anchor = this.data.nodes.find((node) => node.anchor);
    const edges = edgesAboveCutoff(this.data.edges, anchor ? -1 : this.cutoff);
    if (anchor) {
      for (const edge of edges) {
        const node = positions.get(edge.source === anchor.noteId ? edge.target : edge.source)!;
        const label = this.svg.ownerDocument.createElementNS(SVG_NS, "text");
        label.setAttribute("x", String(node.x));
        label.setAttribute("y", String(node.y - 14));
        label.setAttribute("text-anchor", "middle");
        label.classList.add("local-semantic-graph-node-label");
        label.textContent = edge.cosine.toFixed(2);
        this.edgeLayer.append(label);
      }
      this.count.setText(`${this.data.nodes.length} notes`);
      this.highlightSelection();
      return;
    }
    for (const edge of edges) {
      const source = positions.get(edge.source)!, target = positions.get(edge.target)!;
      const line = this.svg.ownerDocument.createElementNS(SVG_NS, "line");
      for (const [key, value] of Object.entries({ x1: source.x, y1: source.y, x2: target.x, y2: target.y })) line.setAttribute(key, String(value));
      line.classList.add("local-semantic-graph-edge");
      const label = this.svg.ownerDocument.createElementNS(SVG_NS, "text");
      const labelledNode = target.anchor ? source : target;
      const labelSide = labelledNode.x < 180 ? -1 : 1;
      label.setAttribute("x", String(labelledNode.x + labelSide * 18));
      label.setAttribute("y", String(labelledNode.y + 4));
      label.setAttribute("text-anchor", labelSide < 0 ? "end" : "start");
      label.classList.add("local-semantic-graph-edge-label");
      label.textContent = edge.cosine.toFixed(3);
      line.setAttribute("aria-label", `${source.title} — ${target.title}. Cosine ${edge.cosine}. Inspect both notes`);
      const choose = () => {
        for (const item of this.edgeElements) item.element.setAttribute("tabindex", item.element === line ? "0" : "-1");
        this.choose({ noteIds: [edge.source, edge.target], cosine: edge.cosine });
      };
      line.addEventListener("click", choose);
      line.addEventListener("focus", choose);
      line.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
        const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (direction) {
          event.preventDefault();
          const index = this.edgeElements.findIndex((item) => item.element === line);
          this.edgeElements[(index + direction + this.edgeElements.length) % this.edgeElements.length]?.element.focus();
        }
      });
      this.edgeElements.push({ edge, element: line });
      this.edgeLayer.append(line, label);
    }
    this.count.setText(`${this.data.nodes.length} notes · ${edges.length} edges`);
    this.highlightSelection();
  }

  private choose(selection: GraphSelection, notify = true): void {
    if (!this.current()) return;
    if (selection.noteIds.length === 1) {
      const id = selection.noteIds[0]!;
      const anchor = this.data.nodes.find((node) => node.anchor && node.noteId !== id);
      let pair: GraphEdge | undefined;
      for (const edge of this.data.edges) {
        if (edge.source !== id && edge.target !== id) continue;
        if (anchor && edge.source !== anchor.noteId && edge.target !== anchor.noteId) continue;
        if (!pair || edge.cosine > pair.cosine) pair = edge;
      }
      if (pair) {
        const otherId = pair.source === id ? pair.target : pair.source;
        const other = this.data.nodes.find((node) => node.noteId === otherId)!;
        selection = { ...selection, cosine: pair.cosine, comparison: `${anchor ? "Reference" : "Strongest pair among listed notes"}: ${other.title}` };
      }
    }
    this.selected = selection;
    const nodes = selection.noteIds.map((id) => this.data.nodes.find((node) => node.noteId === id)).filter((node) => node !== undefined);
    this.legend.setText(nodes.map((node) => `${node.anchor ? "A" : node.rank}. ${node.title}`).join(" — ") + (selection.cosine === undefined ? "" : ` · Cosine ${selection.cosine}${selection.comparison ? ` · ${selection.comparison}` : ""}`));
    this.highlightSelection();
    if (notify) this.select(selection);
  }

  private highlightSelection(): void {
    for (const [id, element] of this.nodeElements) {
      const selected = this.selected.noteIds.includes(id);
      element.classList.toggle("is-selected", selected);
      element.setAttribute("aria-pressed", String(selected));
    }
    for (const { edge, element } of this.edgeElements) {
      const selected = this.selected.noteIds.includes(edge.source) && this.selected.noteIds.includes(edge.target);
      element.classList.toggle("is-selected", selected);
      element.setAttribute("aria-pressed", String(selected));
    }
  }
}
