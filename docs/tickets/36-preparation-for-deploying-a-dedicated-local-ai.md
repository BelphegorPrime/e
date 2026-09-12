# 36 - Preparation for deploying a dedicated local AI runtime environment

**Status:** Done (closed 2026-09-07).

**GitHub:** [#63](https://github.com/BelphegorPrime/e/issues/63)

---

## Context

Today `e init` always provisions OmniRoute together with llama.cpp as the
local AI runtime.

This makes llama.cpp effectively mandatory, even when users want to use a
different provider or no local AI runtime at all.

## Work

- [ ] During `e init`, ask the user which local AI runtime(s) they want to
      include in their flow.
- [ ] Make the selection **multi-selectable**, so multiple local runtimes can
      be enabled at the same time.
- [ ] Include `llamacpp` as the initial available runtime option.
- [ ] Support selecting **none** so users can run the flow without a local AI
      runtime.
- [ ] Only provision/configure the selected runtimes.
- [ ] Keep the runtime selection extensible so additional local AI runtimes
      can be added later without redesigning the `init` flow.

## Future

The initial implementation only needs to support llama.cpp, but the selection
should be designed to accommodate additional local AI runtimes such as:

- Ollama
- vLLM
- Other local inference runtimes
