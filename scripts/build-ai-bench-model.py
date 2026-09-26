"""
Builds public/ai/furnishar-bench-v1.onnx — the AI benchmark workload.

WHAT IT IS: a fixed, seeded, UNTRAINED network with the shape and arithmetic
of a small mobile segmentation model: a MobileNet-V1-width encoder
(depthwise-separable convolutions, 32 -> 512 channels, output stride 16) over
a 192 x 192 RGB input, then a per-pixel 8-class head upsampled back to
192 x 192. About 0.29 G multiply-accumulates per inference: the same order as
MobileNet-class segmentation models (MobileNetV1 at 192 px is ~0.42 GMAC), so
a phone that runs this in real time can plausibly run one of those. Running
it measures how fast THIS phone's browser runtime does the kind of work that
floor/wall segmentation needs.

WHAT IT IS NOT: a scene model. Its outputs are meaningless numbers and
nothing may present them as floors, walls or anything else
(lib/spatial/ai/config.mjs AI_MODELS kind 'benchmark').

Deterministic: the same seed produces the same file, so the model's bytes
(and the benchmark) are reproducible. Needs `onnx` and `numpy`:

    python3 -m venv /tmp/onnxenv && /tmp/onnxenv/bin/pip install onnx==1.17.0 numpy
    /tmp/onnxenv/bin/python scripts/build-ai-bench-model.py
"""
import os
import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

SEED = 20260926
SIZE = 192
CLASSES = 8
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'ai', 'furnishar-bench-v1.onnx')

rng = np.random.default_rng(SEED)
nodes, inits = [], []
counter = [0]
macs = [0]


def name(prefix):
    counter[0] += 1
    return f'{prefix}_{counter[0]}'


def weight(shape):
    fan_in = int(np.prod(shape[1:]))
    w = (rng.standard_normal(shape) * np.sqrt(2.0 / max(fan_in, 1))).astype(np.float32)
    n = name('w')
    inits.append(numpy_helper.from_array(w, n))
    return n


def bias(ch):
    n = name('b')
    inits.append(numpy_helper.from_array(np.zeros(ch, dtype=np.float32), n))
    return n


def conv(x, cin, cout, k=3, stride=1, group=1, relu=True, size=None):
    out = size // stride
    macs[0] += out * out * cout * (cin // group) * k * k
    y = name('conv')
    nodes.append(helper.make_node(
        'Conv', [x, weight([cout, cin // group, k, k]), bias(cout)], [y],
        kernel_shape=[k, k], strides=[stride, stride], pads=[k // 2] * 4, group=group))
    if not relu:
        return y
    z = name('relu')
    nodes.append(helper.make_node('Relu', [y], [z]))
    return z


def separable(x, cin, cout, stride, size):
    x = conv(x, cin, cin, k=3, stride=stride, group=cin, size=size)   # depthwise
    return conv(x, cin, cout, k=1, size=size // stride)               # pointwise


x = conv('input', 3, 32, stride=2, size=192)   # 96
x = separable(x, 32, 64, 1, 96)
x = separable(x, 64, 128, 2, 96)               # 48
x = separable(x, 128, 128, 1, 48)
x = separable(x, 128, 256, 2, 48)              # 24
x = separable(x, 256, 256, 1, 24)
x = separable(x, 256, 512, 2, 24)              # 12
for _ in range(3):
    x = separable(x, 512, 512, 1, 12)
logits = conv(x, 512, CLASSES, k=1, relu=False, size=12)

scales = name('scales')
inits.append(numpy_helper.from_array(np.array([1, 1, SIZE / 12, SIZE / 12], dtype=np.float32), scales))
macs[0] += SIZE * SIZE * CLASSES * 4   # bilinear upsampling, roughly
nodes.append(helper.make_node('Resize', [logits, '', scales], ['output'], mode='linear'))

graph = helper.make_graph(
    nodes, 'furnishar_bench_v1',
    [helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, SIZE, SIZE])],
    [helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, CLASSES, SIZE, SIZE])],
    inits)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='furnishar')
model.ir_version = 8
model.doc_string = 'FurnishAR AI benchmark workload. Untrained synthetic weights: a performance probe, not a scene model.'
onnx.checker.check_model(model)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
onnx.save(model, OUT)
print(OUT, os.path.getsize(OUT), 'bytes,', round(macs[0] / 1e6), 'M multiply-accumulates per inference')
