/**
 * Hermes desktop half. Loaded uncompiled: no JSX, no imports except the SDK and React.
 * Orbit card for ::trellis-model{glb="…" stl="…"}. Status chip from /api/plugins/trellis/status.
 */

import { TRANSCRIPT_DIRECTIVE_AREA, STATUSBAR_AREAS } from "@hermes/plugin-sdk";
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";

function readGlb(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8;
  const bin = buffer.slice(binStart);
  const mesh = json.meshes && json.meshes[0];
  const prim = mesh && mesh.primitives && mesh.primitives[0];
  if (!prim) throw new Error("GLB has no mesh");
  const posAcc = json.accessors[prim.attributes.POSITION];
  const idxAcc = prim.indices != null ? json.accessors[prim.indices] : null;
  return {
    positions: readAccessor(json, bin, posAcc),
    indices: idxAcc ? readAccessor(json, bin, idxAcc) : null,
  };
}

function readAccessor(json, bin, acc) {
  const bv = json.bufferViews[acc.bufferView];
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const view = new DataView(bin, start);
  const comps = acc.type === "VEC3" ? 3 : acc.type === "VEC2" ? 2 : 1;
  const out = new Float32Array(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = (i * comps + c) * 4;
      out[i * comps + c] = acc.componentType === 5126 ? view.getFloat32(o, true) : view.getUint16(o, true);
    }
  }
  if (acc.componentType === 5123 || acc.componentType === 5125) {
    const ints = new Uint32Array(acc.count);
    const stride = acc.componentType === 5125 ? 4 : 2;
    for (let i = 0; i < acc.count; i++) {
      ints[i] = acc.componentType === 5125 ? view.getUint32(i * stride, true) : view.getUint16(i * stride, true);
    }
    return ints;
  }
  return out;
}

function ModelCard({ glb, stl }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState("");
  const [wire, setWire] = useState(false);

  useEffect(() => {
    if (!glb) {
      setError(stl ? "STL is on disk. Orbit needs the GLB path." : "Missing glb path.");
      return undefined;
    }
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let stopped = false;
    let raf = 0;
    const gl = canvas.getContext("webgl");
    if (!gl) {
      setError("WebGL is not available in this view.");
      return undefined;
    }
    const query = "/api/plugins/trellis/model?path=" + encodeURIComponent(glb);
    fetch(query)
      .then((res) => {
        if (!res.ok) throw new Error("model HTTP " + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (stopped) return;
        const mesh = readGlb(buf);
        drawLoop(gl, canvas, mesh, () => wire, (id) => {
          raf = id;
        });
      })
      .catch((e) => setError(String(e.message || e)));
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [glb, stl, wire]);

  return jsxs("div", {
    style: { border: "1px solid var(--ui-stroke-secondary)", borderRadius: 8, padding: 8, maxWidth: 420 },
    children: [
      jsx("canvas", { ref: canvasRef, width: 400, height: 280, style: { width: "100%", height: 280, background: "transparent" } }),
      error ? jsx("div", { style: { color: "var(--ui-text-tertiary)", fontSize: 12 }, children: error }) : null,
      jsxs("div", {
        style: { display: "flex", gap: 8, marginTop: 6 },
        children: [
          jsx("button", { type: "button", onClick: () => setWire((v) => !v), children: wire ? "Solid" : "Wireframe" }),
          stl ? jsx("span", { style: { fontSize: 12, color: "var(--ui-text-tertiary)" }, children: "STL ready" }) : null,
        ],
      }),
    ],
  });
}

function drawLoop(gl, canvas, mesh, wireFn, setRaf) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, "attribute vec3 p; uniform float yaw; uniform float pitch; varying vec3 vN; void main(){ float c=cos(yaw),s=sin(yaw),cp=cos(pitch),sp=sin(pitch); vec3 r=vec3(c*p.x+s*p.z,p.y,-s*p.x+c*p.z); r=vec3(r.x,cp*r.y-sp*r.z,sp*r.y+cp*r.z); vN=r; vec3 e=r+vec3(0.0,-0.05,-2.6); gl_Position=vec4(e.x*3.2,e.y*4.2,e.z*0.15,-e.z); }");
  gl.compileShader(vs);
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, "precision mediump float; varying vec3 vN; uniform vec3 color; void main(){ vec3 n=normalize(vN); float light=0.35+0.65*max(0.0,dot(n,normalize(vec3(0.35,0.75,0.55)))); gl_FragColor=vec4(color*light,1.0); }");
  gl.compileShader(fs);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
  let ibo = null;
  if (mesh.indices) {
    ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  }
  let yaw = 0.4;
  let pitch = 0.3;
  let drag = null;
  canvas.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY, yaw, pitch };
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointerup = () => {
    drag = null;
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
    pitch = drag.pitch + (e.clientY - drag.y) * 0.01;
  };
  gl.getExtension("OES_element_index_uint");
  gl.enable(gl.DEPTH_TEST);
  const frame = () => {
    if (!drag) yaw += 0.005;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniform1f(gl.getUniformLocation(prog, "yaw"), yaw);
    gl.uniform1f(gl.getUniformLocation(prog, "pitch"), pitch);
    gl.uniform3f(gl.getUniformLocation(prog, "color"), 0.75, 0.78, 0.72);
    const count = mesh.indices ? mesh.indices.length : mesh.positions.length / 3;
    const mode = wireFn() ? gl.LINES : gl.TRIANGLES;
    if (mesh.indices) gl.drawElements(mode, count, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(mode, 0, count);
    setRaf(requestAnimationFrame(frame));
  };
  frame();
}

function StatusChip() {
  const [state, setState] = useState({ up: false, busy: false, models: 0 });
  useEffect(() => {
    let stop = false;
    const tick = () => {
      fetch("/api/plugins/trellis/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!stop && data) setState(data);
        })
        .catch(() => undefined);
    };
    tick();
    const id = setInterval(tick, 8000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);
  const label = state.busy ? "Trellis · printing" : state.up ? "Trellis · up" : "Trellis · down";
  return jsx("span", {
    style: { fontSize: 11, padding: "0 6px", color: "var(--ui-text-tertiary)" },
    title: state.models ? state.models + " prints recorded" : "ComfyUI status",
    children: label,
  });
}

export default {
  id: "trellis",
  name: "Trellis",
  defaultEnabled: true,
  register(ctx) {
    ctx.register({
      id: "status",
      area: STATUSBAR_AREAS.right,
      order: 40,
      render: () => jsx(StatusChip, {}),
    });
    ctx.register({
      id: "model-card",
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: "trellis-model",
        render: ({ attrs }) => jsx(ModelCard, { glb: attrs.glb || "", stl: attrs.stl || "" }),
      },
    });
  },
};
