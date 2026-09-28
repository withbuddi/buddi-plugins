// @huggingface/transformers' Node build loads onnxruntime-node and never this
// package; the speech plugin overrides it with this stub so npm does not
// install 90 MB nobody runs. Loading it means that stopped being true.
throw new Error('onnxruntime-web is not installed with the speech plugin: Transformers.js runs on onnxruntime-node in Node.');
