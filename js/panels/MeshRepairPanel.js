import * as THREE from 'three';
import { MeshData } from '../core/MeshData.js';
import { repairMeshData } from '../geometry/ManifoldRepair.js';
import { MeshRendererAdapter } from '../geometry/MeshRendererAdapter.js';
import { DEFAULT_SHADING_MODE, DEFAULT_SHADING_ANGLE } from '../utils/ShadingUtils.js';
import { AddObjectCommand } from '../commands/AddObjectCommand.js';

const REPORT_FIELDS = [
  ['weldedVerts', '焊接顶点 (weldedVerts)'],
  ['removedFaces', '移除面 (removedFaces)'],
  ['splitVerts', '分裂顶点 (splitVerts)'],
  ['flippedFaces', '翻转面 (flippedFaces)'],
  ['filledHoles', '填补洞 (filledHoles)'],
  ['skippedHoles', '跳过洞 (skippedHoles)'],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 基于修复后的 MeshData 拓扑（vertices/edges/faces Map 与 faceIds）计算额外统计。
 */
export function computeTopologyStats(meshData) {
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  const boundaryAdj = new Map(); // vertexId -> Set of adjacent vertexIds (boundary edges only)

  for (const edge of meshData.edges.values()) {
    const faceCount = edge.faceIds.size;
    if (faceCount === 1) {
      boundaryEdges++;
      if (!boundaryAdj.has(edge.v1Id)) boundaryAdj.set(edge.v1Id, new Set());
      if (!boundaryAdj.has(edge.v2Id)) boundaryAdj.set(edge.v2Id, new Set());
      boundaryAdj.get(edge.v1Id).add(edge.v2Id);
      boundaryAdj.get(edge.v2Id).add(edge.v1Id);
    } else if (faceCount > 2) {
      nonManifoldEdges++;
    }
  }

  // 开放边界环 = 边界边图的连通分量数量（每个分量即一条开放边界环/链）
  let openBoundaryLoops = 0;
  const visited = new Set();
  for (const start of boundaryAdj.keys()) {
    if (visited.has(start)) continue;
    openBoundaryLoops++;
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const next of boundaryAdj.get(cur)) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
  }

  let repairFaces = 0;
  for (const face of meshData.faces.values()) {
    if (face.isRepairFace === true || face.id === -1) repairFaces++;
  }

  return { openBoundaryLoops, boundaryEdges, nonManifoldEdges, repairFaces };
}

/**
 * 构造一个含重复顶点且缺一个面的立方体，用于人工验证修复计数。
 */
export function createBrokenCubeMeshData() {
  const meshData = new MeshData();
  const h = 0.5;

  const v0 = meshData.addVertex(new THREE.Vector3(-h, -h, -h));
  const v1 = meshData.addVertex(new THREE.Vector3( h, -h, -h));
  const v2 = meshData.addVertex(new THREE.Vector3( h,  h, -h));
  const v3 = meshData.addVertex(new THREE.Vector3(-h,  h, -h));
  const v4 = meshData.addVertex(new THREE.Vector3(-h, -h,  h));
  const v5 = meshData.addVertex(new THREE.Vector3( h, -h,  h));
  const v6 = meshData.addVertex(new THREE.Vector3( h,  h,  h));
  const v7 = meshData.addVertex(new THREE.Vector3(-h,  h,  h));

  // 与 v0 坐标完全相同的重复顶点，并在左面中使用它 -> 修复时应被焊接
  const v0dup = meshData.addVertex(new THREE.Vector3(-h, -h, -h));

  meshData.addFace([v3, v2, v1, v0]);      // 后
  meshData.addFace([v4, v5, v6, v7]);      // 前
  meshData.addFace([v0dup, v4, v7, v3]);   // 左（使用重复顶点）
  meshData.addFace([v2, v6, v5, v1]);      // 右
  // 顶面 [v3, v7, v6, v2] 故意缺失 -> 修复时应被填补
  meshData.addFace([v1, v5, v4, v0]);      // 底

  return meshData;
}

export class MeshRepairPanel {
  constructor(editor, container) {
    this.editor = editor;
    this.container = container;

    this.options = {
      weldEpsilon: 1e-6,
      fixWinding: true,
      fillHoles: true,
      maxHoleFillEdges: 128,
    };

    this.root = el('div', 'repair-panel');
    this.container.appendChild(this.root);

    this.buildControls();

    this.resultsEl = el('div', 'repair-results');
    this.root.appendChild(this.resultsEl);

    this.editor.signals.objectSelected.add(() => this.refresh());

    this.refresh();
  }

  buildControls() {
    const title = el('h3', 'repair-title', '网格修复报告');
    this.root.appendChild(title);

    const list = el('ul', 'project-settings-list');

    // weldEpsilon
    const epsRow = el('li', 'setting-option');
    epsRow.appendChild(el('span', 'label', 'Weld Epsilon'));
    const epsInput = document.createElement('input');
    epsInput.type = 'number';
    epsInput.min = '0';
    epsInput.step = '0.000001';
    epsInput.value = String(this.options.weldEpsilon);
    epsInput.addEventListener('change', () => {
      const v = parseFloat(epsInput.value);
      if (Number.isFinite(v) && v > 0) this.options.weldEpsilon = v;
    });
    epsRow.appendChild(epsInput);
    list.appendChild(epsRow);

    // fixWinding / fillHoles
    for (const [key, label] of [['fixWinding', 'Fix Winding'], ['fillHoles', 'Fill Holes']]) {
      const row = el('li', 'setting-option');
      row.appendChild(el('span', 'label', label));
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.options[key];
      cb.addEventListener('change', () => { this.options[key] = cb.checked; });
      row.appendChild(cb);
      list.appendChild(row);
    }

    // maxHoleFillEdges
    const maxRow = el('li', 'setting-option');
    maxRow.appendChild(el('span', 'label', 'Max Hole Edges'));
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.min = '3';
    maxInput.step = '1';
    maxInput.value = String(this.options.maxHoleFillEdges);
    maxInput.addEventListener('change', () => {
      const v = parseInt(maxInput.value, 10);
      if (Number.isFinite(v) && v >= 3) this.options.maxHoleFillEdges = v;
    });
    maxRow.appendChild(maxInput);
    list.appendChild(maxRow);

    // Buttons
    const btnRow = el('li', 'setting-option');
    const rerunBtn = el('button', 'action-button', '重新检测');
    rerunBtn.addEventListener('click', () => this.refresh());
    btnRow.appendChild(rerunBtn);

    const sampleBtn = el('button', 'action-button', '创建验证样例');
    sampleBtn.style.marginLeft = '6px';
    sampleBtn.addEventListener('click', () => this.createSample());
    btnRow.appendChild(sampleBtn);
    list.appendChild(btnRow);

    this.root.appendChild(list);
    this.root.appendChild(el('div', 'panel-divider'));
  }

  getTargetObject() {
    const selected = this.editor.selection.getSelectedObject() ?? [];
    if (selected.length === 0) return { status: 'no-selection' };
    const object = selected.find(o => o.userData?.meshData);
    if (!object) return { status: 'no-meshdata' };
    return { status: 'ok', object };
  }

  refresh() {
    this.resultsEl.innerHTML = '';

    const target = this.getTargetObject();

    if (target.status === 'no-selection') {
      this.resultsEl.appendChild(
        el('p', 'repair-empty', '未选中任何对象。请在场景中选择一个对象后再检测。')
      );
      return;
    }

    if (target.status === 'no-meshdata') {
      this.resultsEl.appendChild(
        el('p', 'repair-empty', '选中对象缺少 userData.meshData，无法执行网格修复检测。')
      );
      return;
    }

    let meshData = target.object.userData.meshData;
    if (!(meshData instanceof MeshData)) {
      meshData = MeshData.getRehydratedMeshData(meshData);
    }

    let repaired;
    try {
      repaired = repairMeshData(meshData, { ...this.options });
    } catch (err) {
      this.resultsEl.appendChild(
        el('p', 'repair-error', `修复检测失败：${err?.message ?? err}`)
      );
      return;
    }

    const report = repaired.repairReport;
    const stats = computeTopologyStats(repaired);

    this.renderReport(target.object, repaired, report, stats);
  }

  renderReport(object, repaired, report, stats) {
    const objName = el('p', 'repair-object', `对象：${object.name || '(未命名)'}`);
    this.resultsEl.appendChild(objName);

    // 六项修复计数
    const counts = el('div', 'repair-stats');
    for (const [key, label] of REPORT_FIELDS) {
      const row = el('div', 'repair-stat-row');
      row.appendChild(el('span', 'repair-stat-label', label));
      row.appendChild(el('span', 'repair-stat-value', String(report[key] ?? 0)));
      counts.appendChild(row);
    }
    this.resultsEl.appendChild(counts);

    this.resultsEl.appendChild(el('div', 'panel-divider'));

    // 修复后拓扑统计
    const topoTitle = el('h4', 'repair-subtitle', '修复后拓扑检查');
    this.resultsEl.appendChild(topoTitle);

    const topo = el('div', 'repair-stats');
    const topoRows = [
      ['开放边界环数量', stats.openBoundaryLoops],
      ['非流形边数量 (>2 面共享)', stats.nonManifoldEdges],
      ['修复新增面数量', stats.repairFaces],
      ['顶点 / 边 / 面', `${repaired.vertices.size} / ${repaired.edges.size} / ${repaired.faces.size}`],
    ];
    for (const [label, value] of topoRows) {
      const row = el('div', 'repair-stat-row');
      row.appendChild(el('span', 'repair-stat-label', label));
      row.appendChild(el('span', 'repair-stat-value', String(value)));
      topo.appendChild(row);
    }
    this.resultsEl.appendChild(topo);

    this.resultsEl.appendChild(el('div', 'panel-divider'));

    // warnings
    const warnTitle = el('h4', 'repair-subtitle', `警告 (${report.warnings.length})`);
    this.resultsEl.appendChild(warnTitle);

    if (report.warnings.length === 0) {
      this.resultsEl.appendChild(el('p', 'repair-empty', '无警告。'));
    } else {
      const list = el('ul', 'repair-warnings');
      for (const w of report.warnings) {
        list.appendChild(el('li', 'repair-warning-item', String(w)));
      }
      this.resultsEl.appendChild(list);
    }
  }

  /**
   * 创建一个含重复顶点与缺面的立方体样例并加入场景（通过命令系统，可撤销），
   * 用于人工验证面板计数变化。
   */
  createSample() {
    const meshData = createBrokenCubeMeshData();

    const mode = DEFAULT_SHADING_MODE;
    const angle = DEFAULT_SHADING_ANGLE;
    const sharps = new Set();

    const { geometry, renderBuffer } = MeshRendererAdapter.toBufferGeometry(meshData, { mode, angle, sharps });

    const material = new THREE.MeshStandardMaterial({ color: 0xcc8844, metalness: 0.2, roughness: 0.4, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.meshData = meshData;
    mesh.userData.renderBuffer = renderBuffer;
    mesh.userData.shading = mode;
    mesh.userData.shadingAngle = angle;
    mesh.userData.sharp = sharps;
    mesh.userData.seam = new Set();
    mesh.name = this.editor.nameManager.generateUniqueName('RepairSample');

    this.editor.execute(new AddObjectCommand(this.editor, mesh));
    this.editor.signals.sceneGraphChanged.dispatch();

    this.refresh();
  }
}
