import { useState } from 'react';
import { Alert, Form, Input, Button, message } from 'antd';
import { walletApi } from '../../helpers/walletApi';

/** Accepts a decimal ("137") or hex ("0x89") chain ID and returns canonical hex, or null. */
export function toHexChainId(value) {
  const trimmed = String(value ?? '').trim();
  try {
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return `0x${BigInt(trimmed).toString(16)}`;
    if (/^[1-9]\d*$/.test(trimmed)) return `0x${BigInt(trimmed).toString(16)}`;
  } catch {
    return null;
  }
  return null;
}

const AddChainForm = ({ onSaved }) => {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);

  const handleAddChain = async (values) => {
    setBusy(true);
    try {
      await walletApi.addNetwork({
        chainId: toHexChainId(values.chainId),
        name: values.name,
        ticker: values.ticker,
        rpcUrl: values.rpcUrl,
        blockExplorerUrl: values.blockExplorerUrl || '',
      });
      message.success('Network added');
      form.resetFields();
      await onSaved();
    } catch (error) {
      message.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form form={form} onFinish={handleAddChain} layout="vertical" style={{ maxHeight: 'calc(60vh - 50px)', overflowY: 'auto' }}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="The RPC provider can see your addresses and IP. Only add networks you trust." />
      <Form.Item name="name" label="Network name" rules={[{ required: true, message: 'Enter a name' }]}>
        <Input data-testid="add-chain-name-input" maxLength={64} />
      </Form.Item>
      <Form.Item
        name="chainId"
        label="Chain ID"
        rules={[{ required: true, validator: (_, value) => (toHexChainId(value) ? Promise.resolve() : Promise.reject(new Error('Enter a decimal or 0x-hex chain ID'))) }]}
      >
        <Input data-testid="add-chain-id-input" placeholder="e.g. 137" />
      </Form.Item>
      <Form.Item name="ticker" label="Currency symbol" rules={[{ required: true, message: 'Enter the symbol' }]}>
        <Input data-testid="add-chain-ticker-input" maxLength={12} />
      </Form.Item>
      <Form.Item name="rpcUrl" label="RPC URL" rules={[{ required: true, message: 'Enter the RPC URL' }]}>
        <Input data-testid="add-chain-rpc-url-input" placeholder="https://" />
      </Form.Item>
      <Form.Item name="blockExplorerUrl" label="Block explorer URL (optional)">
        <Input data-testid="add-chain-explorer-url-input" placeholder="https://" />
      </Form.Item>
      <Button data-testid="add-chain-submit-button" type="primary" htmlType="submit" loading={busy} style={{ width: '100%' }}>
        Add Network
      </Button>
    </Form>
  );
};

export default AddChainForm;
