use std::collections::HashMap;
use std::sync::mpsc as std_mpsc;

use crate::CodeModeToolKind;
use crate::ExecuteRequest;
use crate::FunctionCallOutputContentItem;
use crate::ToolName;
use serde_json::Value as JsonValue;
use tokio::sync::mpsc;

const MUSL_V8_UNAVAILABLE: &str =
    "code mode V8 engine is unavailable on Linux musl targets (upstream rusty_v8 does not publish musl archives)";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistentContextConfig {
    pub module_source: String,
    pub exports: Vec<String>,
    pub max_source_bytes: usize,
    pub max_output_bytes: usize,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum RuntimeCommand {
    ToolResponse { id: String, result: JsonValue },
    ToolError { id: String, error_text: String },
    TimeoutFired { id: u64 },
    ObservePendingFrontier,
    Terminate,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[allow(dead_code)]
pub(crate) enum PendingRuntimeMode {
    #[cfg(test)]
    Continue,
    PauseUntilResumed,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum RuntimeControlCommand {
    Continue,
    Resume,
    Terminate,
}

#[derive(Debug)]
#[allow(dead_code)]
pub(crate) enum RuntimeEvent {
    Started,
    Pending,
    ContentItem(FunctionCallOutputContentItem),
    YieldRequested,
    ToolCall {
        id: String,
        enqueue_ordinal: u64,
        name: ToolName,
        kind: CodeModeToolKind,
        input: Option<JsonValue>,
    },
    Notify {
        call_id: String,
        text: String,
    },
    Result {
        stored_value_writes: HashMap<String, JsonValue>,
        error_text: Option<String>,
    },
}

pub(crate) struct RuntimeTerminationHandle;

impl RuntimeTerminationHandle {
    pub(crate) fn terminate_execution(&self) -> bool {
        false
    }
}

pub(crate) struct PersistentRuntime;

impl PersistentRuntime {
    pub(crate) fn new(_config: PersistentContextConfig) -> Result<Self, String> {
        Err(MUSL_V8_UNAVAILABLE.to_string())
    }

    pub(crate) fn validate_source(&self, _source: &str) -> Result<(), String> {
        Err(MUSL_V8_UNAVAILABLE.to_string())
    }

    pub(crate) fn is_alive(&self) -> bool {
        false
    }

    pub(crate) fn start(
        &self,
        _stored_values: HashMap<String, JsonValue>,
        _request: ExecuteRequest,
        _events: mpsc::UnboundedSender<RuntimeEvent>,
    ) -> Result<
        (
            std_mpsc::Sender<RuntimeCommand>,
            std_mpsc::Sender<RuntimeControlCommand>,
            RuntimeTerminationHandle,
        ),
        String,
    > {
        Err(MUSL_V8_UNAVAILABLE.to_string())
    }

    pub(crate) fn shutdown(&self) {}
}

pub(crate) fn spawn_runtime(
    _stored_values: HashMap<String, JsonValue>,
    _request: ExecuteRequest,
    _event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    _pending_mode: PendingRuntimeMode,
) -> Result<
    (
        std_mpsc::Sender<RuntimeCommand>,
        std_mpsc::Sender<RuntimeControlCommand>,
        RuntimeTerminationHandle,
    ),
    String,
> {
    Err(MUSL_V8_UNAVAILABLE.to_string())
}
