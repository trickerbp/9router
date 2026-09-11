"use client";

import { useState, useEffect, useRef } from "react";
import PropTypes from "prop-types";
import Modal from "@/shared/components/Modal";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { isOpenAICompatibleProvider, isAnthropicCompatibleProvider, AI_PROVIDERS, supportsRelayBaseUrl, normalizeRelayBaseUrl, RELAY_PROVIDER_PATHS } from "@/shared/constants/providers";
import Select from "@/shared/components/Select";

export default function EditConnectionModal({ isOpen, connection, proxyPools, onSave, onClose }) {
  const [formData, setFormData] = useState({
    name: "",
    priority: 1,
    apiKey: "",
    defaultModel: "",
  });
  const [azureData, setAzureData] = useState({
    azureEndpoint: "",
    apiVersion: "2024-10-01-preview",
    deployment: "",
    organization: "",
  });
  const [cloudflareData, setCloudflareData] = useState({ accountId: "" });
  const [relayBaseUrl, setRelayBaseUrl] = useState("");
  const [region, setRegion] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [validationError, setValidationError] = useState("");
  const [validatedRelayBaseUrl, setValidatedRelayBaseUrl] = useState(null);
  const initialRelayBaseUrlRef = useRef("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (connection) {
      // Reset the editable form when the selected connection changes.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFormData({
        name: connection.name || "",
        priority: connection.priority || 1,
        apiKey: "",
        defaultModel: connection.defaultModel || "",
      });
      // Load Azure-specific data if present
      if (connection.provider === "azure" && connection.providerSpecificData) {
        setAzureData({
          azureEndpoint: connection.providerSpecificData.azureEndpoint || "",
          apiVersion: connection.providerSpecificData.apiVersion || "2024-10-01-preview",
          deployment: connection.providerSpecificData.deployment || "",
          organization: connection.providerSpecificData.organization || "",
        });
      }
      if (connection.provider === "cloudflare-ai" && connection.providerSpecificData) {
        setCloudflareData({ accountId: connection.providerSpecificData.accountId || "" });
      }
      const savedRelayBaseUrl = supportsRelayBaseUrl(connection.provider)
        ? (connection.providerSpecificData?.baseUrl || "")
        : "";
      setRelayBaseUrl(savedRelayBaseUrl);
      initialRelayBaseUrlRef.current = savedRelayBaseUrl;
      // Load region for providers that support it (e.g. xiaomi-tokenplan)
      const providerCfg = AI_PROVIDERS?.[connection.provider];
      if (providerCfg?.regions) {
        const savedRegion = connection.providerSpecificData?.region || providerCfg.defaultRegion || providerCfg.regions[0]?.id || "";
        setRegion(savedRegion);
      }
      setTestResult(null);
      setValidationResult(null);
      setValidationError("");
      setValidatedRelayBaseUrl(null);
    }
  }, [connection]);

  const isOAuth = connection?.authType === "oauth";
  const isAzure = connection?.provider === "azure";
  const isCloudflareAi = connection?.provider === "cloudflare-ai";
  const isCompatible = connection
    ? (isOpenAICompatibleProvider(connection.provider) || isAnthropicCompatibleProvider(connection.provider))
    : false;
  const providerRegions = connection ? (AI_PROVIDERS?.[connection.provider]?.regions || null) : null;
  // Relay Base URL override — API-key connections on claude/codex only.
  const isRelayCapable = !isOAuth && supportsRelayBaseUrl(connection?.provider);
  const requiresModel = isCompatible || isRelayCapable;
  const relayPath = RELAY_PROVIDER_PATHS[connection?.provider] || "";
  const normalizedRelayBaseUrl = isRelayCapable
    ? (normalizeRelayBaseUrl(connection.provider, relayBaseUrl) || "")
    : "";
  const hasRelayBaseUrlChanged = () => isRelayCapable && normalizedRelayBaseUrl !== (
    normalizeRelayBaseUrl(connection.provider, initialRelayBaseUrlRef.current) || ""
  );
  const selectedModel = formData.defaultModel.trim();
  const hasDefaultModelChanged = () => requiresModel && selectedModel !== (connection.defaultModel || "").trim();

  const showModelRequiredError = () => {
    const error = "Enter the model to check and save this connection.";
    setValidationResult("failed");
    setValidationError(error);
    return { valid: false, error };
  };

  // Build providerSpecificData for region-aware providers
  const buildRegionSpecificData = () => {
    if (providerRegions && region) return { ...((connection?.providerSpecificData) || {}), region };
    return undefined;
  };

  const buildValidationPayload = () => {
    const payload = { provider: connection.provider };
    const enteredApiKey = formData.apiKey.trim();
    if (enteredApiKey) payload.apiKey = enteredApiKey;
    else if (!isOAuth) payload.connectionId = connection.id;
    if (requiresModel) {
      payload.defaultModel = selectedModel;
    }

    let specificData;
    if (isAzure) specificData = { ...azureData };
    else if (isCloudflareAi) specificData = { ...cloudflareData };
    else if (providerRegions) specificData = buildRegionSpecificData();
    if (isRelayCapable) specificData = { ...(specificData || {}), baseUrl: relayBaseUrl.trim() };
    if (specificData && Object.keys(specificData).length > 0) payload.providerSpecificData = specificData;
    return payload;
  };

  const validateCurrentSettings = async () => {
    if (requiresModel && !selectedModel) return showModelRequiredError();
    setValidating(true);
    setValidationResult(null);
    setValidationError("");
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildValidationPayload()),
      });
      const data = await res.json().catch(() => ({}));
      const valid = res.ok && !!data.valid;
      setValidationResult(valid ? "success" : "failed");
      setValidationError(valid ? "" : (data.error || "Validation failed"));
      if (valid && isRelayCapable) setValidatedRelayBaseUrl(normalizedRelayBaseUrl);
      return { valid, error: valid ? null : (data.error || "Validation failed") };
    } catch (error) {
      const message = error?.message || "Validation failed";
      setValidationResult("failed");
      setValidationError(message);
      return { valid: false, error: message };
    } finally {
      setValidating(false);
    }
  };

  const handleTest = async () => {
    if (!connection?.provider) return;
    if (requiresModel && !selectedModel) {
      showModelRequiredError();
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      // Unsaved relay settings (including a blank key or changed Base URL) are
      // checked through the same server-side inference probe used before save.
      if (isRelayCapable && (formData.apiKey.trim() || hasRelayBaseUrlChanged() || hasDefaultModelChanged())) {
        const result = await validateCurrentSettings();
        setTestResult(result.valid ? "success" : "failed");
        return;
      }
      const res = await fetch(`/api/providers/${connection.id}/test`, { method: "POST" });
      const data = await res.json();
      setTestResult(data.valid ? "success" : "failed");
    } catch {
      setTestResult("failed");
    } finally {
      setTesting(false);
    }
  };

  const handleValidate = async () => {
    if (!connection?.provider || (!formData.apiKey.trim() && isOAuth)) return;
    await validateCurrentSettings();
  };

  const handleSubmit = async () => {
    if (!connection) return;
    if (requiresModel && !selectedModel) {
      showModelRequiredError();
      return;
    }
    setSaving(true);
    try {
      const updates = {
        name: formData.name,
        priority: formData.priority,
      };
      const enteredApiKey = formData.apiKey.trim();
      const needsValidation = !isOAuth && (
        Boolean(enteredApiKey) ||
        (isRelayCapable && hasRelayBaseUrlChanged()) ||
        hasDefaultModelChanged()
      );
      if (needsValidation) {
        const alreadyValidated =
          validationResult === "success" &&
          (!isRelayCapable || validatedRelayBaseUrl === normalizedRelayBaseUrl);
        const result = alreadyValidated ? { valid: true } : await validateCurrentSettings();
        if (!result.valid) {
          // Do not persist a new secret or an unverified relay endpoint.
          return;
        }
        if (enteredApiKey) updates.apiKey = enteredApiKey;
        updates.testStatus = "active";
        updates.lastError = null;
        updates.lastErrorAt = null;
      }
      if (requiresModel) updates.defaultModel = selectedModel;
      
      // Add Azure-specific data if this is an Azure connection
      if (isAzure) {
        updates.providerSpecificData = {
          azureEndpoint: azureData.azureEndpoint,
          apiVersion: azureData.apiVersion,
          deployment: azureData.deployment,
          organization: azureData.organization,
        };
      }
      if (isCloudflareAi) {
        updates.providerSpecificData = { accountId: cloudflareData.accountId };
      }
      // Persist updated region for region-aware providers
      if (providerRegions && region) {
        updates.providerSpecificData = buildRegionSpecificData();
      }
      // Always send the key so clearing the field drops back to the official host.
      if (isRelayCapable) {
        updates.providerSpecificData = {
          ...(updates.providerSpecificData || {}),
          baseUrl: relayBaseUrl.trim(),
        };
      }
      
      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  if (!connection) return null;

  return (
    <Modal isOpen={isOpen} title="Edit Connection" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder={isOAuth ? "Account name" : "Production Key"}
        />
        {isOAuth && connection.email && (
          <div className="bg-sidebar/50 p-3 rounded-lg">
            <p className="text-sm text-text-muted mb-1">Email</p>
            <p className="font-medium">{connection.email}</p>
          </div>
        )}
        <Input
          label="Priority"
          type="number"
          value={formData.priority}
          onChange={(e) => setFormData({ ...formData, priority: Number.parseInt(e.target.value, 10) || 1 })}
        />

        {!isOAuth && (
          <>
            <div className="flex gap-2">
              <Input
                label="API Key"
                type="password"
                value={formData.apiKey}
                onChange={(e) => {
                  setFormData({ ...formData, apiKey: e.target.value });
                  setValidationResult(null);
                  setValidationError("");
                  setValidatedRelayBaseUrl(null);
                }}
                placeholder="Enter new API key"
                hint="Leave blank to keep the current API key."
                className="flex-1"
              />
              <div className="pt-6">
                <Button onClick={handleValidate} disabled={(!formData.apiKey.trim() && isOAuth) || validating || saving || (requiresModel && !selectedModel)} variant="secondary">
                  {validating ? "Checking..." : "Check"}
                </Button>
              </div>
            </div>
            {validationResult && (
              <Badge variant={validationResult === "success" ? "success" : "error"}>
                {validationResult === "success" ? "Valid" : "Invalid"}
              </Badge>
            )}
            {validationError && (
              <p className="text-xs text-red-500 break-words">{validationError}</p>
            )}
          </>
        )}

        {isAzure && (
          <div className="bg-sidebar/50 p-4 rounded-lg border border-accent/20">
            <h3 className="font-semibold mb-3 text-sm">Azure OpenAI Configuration</h3>
            <div className="flex flex-col gap-3">
              <Input
                label="Azure Endpoint"
                value={azureData.azureEndpoint}
                onChange={(e) => setAzureData({ ...azureData, azureEndpoint: e.target.value })}
                placeholder="https://your-resource.openai.azure.com"
                hint="Your Azure OpenAI resource endpoint URL"
              />
              <Input
                label="Deployment Name"
                value={azureData.deployment}
                onChange={(e) => setAzureData({ ...azureData, deployment: e.target.value })}
                placeholder="gpt-4"
                hint="The deployment name in your Azure resource"
              />
              <Input
                label="API Version"
                value={azureData.apiVersion}
                onChange={(e) => setAzureData({ ...azureData, apiVersion: e.target.value })}
                placeholder="2024-10-01-preview"
                hint="Azure OpenAI API version to use"
              />
              <Input
                label="Organization"
                value={azureData.organization}
                onChange={(e) => setAzureData({ ...azureData, organization: e.target.value })}
                placeholder="Organization ID"
                hint="Required for billing"
              />
            </div>
          </div>
        )}

        {isRelayCapable && (
          <>
            <Input
              label="Base URL (optional)"
              value={relayBaseUrl}
              onChange={(e) => {
                setRelayBaseUrl(e.target.value);
                setValidationResult(null);
                setValidationError("");
                setValidatedRelayBaseUrl(null);
                setTestResult(null);
              }}
              placeholder="https://your-relay.example/v1"
              hint="Relay base URL for this key, with or without /v1. Clear it to go back to the official endpoint."
            />
            {normalizeRelayBaseUrl(connection.provider, relayBaseUrl) && (
              <p className="text-xs text-text-muted break-all">
                Requests will go to{" "}
                <code>{normalizeRelayBaseUrl(connection.provider, relayBaseUrl)}{relayPath}</code>
              </p>
            )}
          </>
        )}

        {requiresModel && (
          <Input
            label="Model"
            value={formData.defaultModel}
            onChange={(e) => {
              setFormData({ ...formData, defaultModel: e.target.value });
              setValidationResult(null);
              setValidationError("");
              setTestResult(null);
            }}
            placeholder={connection.provider === "claude" ? "claude-sonnet-4-6" : "gpt-5.2-codex"}
            hint="Used by Check and saved as this connection's default model."
          />
        )}

        {isRelayCapable && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing || saving || !selectedModel}>
              {testing ? "Testing..." : formData.apiKey ? "Test New Settings" : "Test Saved Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        {providerRegions && (
          <Select
            label="Region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            options={providerRegions.map((r) => ({ value: r.id, label: r.label }))}
          />
        )}

        {!isCompatible && !isAzure && !isCloudflareAi && !isRelayCapable && (
          <div className="flex items-center gap-3">
            <Button onClick={handleTest} variant="secondary" disabled={testing}>
              {testing ? "Testing..." : "Test Connection"}
            </Button>
            {testResult && (
              <Badge variant={testResult === "success" ? "success" : "error"}>
                {testResult === "success" ? "Valid" : "Failed"}
              </Badge>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
          <Button onClick={onClose} variant="ghost" fullWidth>Cancel</Button>
        </div>
      </div>
    </Modal>
  );
}

EditConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  connection: PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
    email: PropTypes.string,
    priority: PropTypes.number,
    authType: PropTypes.string,
    provider: PropTypes.string,
    defaultModel: PropTypes.string,
    providerSpecificData: PropTypes.object,
  }),
  proxyPools: PropTypes.arrayOf(PropTypes.shape({
    id: PropTypes.string,
    name: PropTypes.string,
  })),
  onSave: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
};
