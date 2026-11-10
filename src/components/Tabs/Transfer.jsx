import { useState } from 'react';
import { Alert, Button, Descriptions, Input, Typography, message } from 'antd';
import { walletApi } from '../../helpers/walletApi';
import { formatAmount } from '../../helpers/rpc';

const { Text } = Typography;

/** Two-step send: the background builds an immutable proposal, the user reviews it, then it is signed as-is. */
const Transfer = ({ account, network, onSent }) => {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hash, setHash] = useState(null);

  const review = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setHash(null);
    try {
      setProposal(await walletApi.prepareSend(to, amount));
    } catch (reviewError) {
      setError(reviewError.message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const txHash = await walletApi.confirmSend(proposal.id);
      setHash(txHash);
      setProposal(null);
      setTo('');
      setAmount('');
      message.success('Transaction sent');
      onSent?.();
    } catch (sendError) {
      setError(sendError.message);
      setProposal(null);
    } finally {
      setBusy(false);
    }
  };

  if (proposal) {
    return (
      <div>
        <Descriptions size="small" column={1} bordered title="Review transfer">
          <Descriptions.Item label="Network">{network.name}</Descriptions.Item>
          <Descriptions.Item label="From">{account.name}</Descriptions.Item>
          <Descriptions.Item label="To"><Text style={{ wordBreak: 'break-all' }}>{proposal.to}</Text></Descriptions.Item>
          <Descriptions.Item label="Amount">{proposal.display.valueEther} {network.ticker}</Descriptions.Item>
          <Descriptions.Item label="Max network fee">{formatAmount(proposal.display.maxFeeEther, 6)} {network.ticker}</Descriptions.Item>
          <Descriptions.Item label="Max total">{formatAmount(proposal.display.maxTotalEther, 6)} {network.ticker}</Descriptions.Item>
        </Descriptions>
        {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Button data-testid="transfer-cancel-button" block disabled={busy} onClick={() => setProposal(null)}>
            Cancel
          </Button>
          <Button data-testid="transfer-confirm-button" block type="primary" loading={busy} onClick={confirm}>
            Confirm
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={review}>
      <div className="sendRow">
        <label htmlFor="transfer-to" style={{ width: 70, textAlign: 'left' }}>To</label>
        <Input id="transfer-to" data-testid="transfer-recipient-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" autoComplete="off" />
      </div>
      <div className="sendRow">
        <label htmlFor="transfer-amount" style={{ width: 70, textAlign: 'left' }}>Amount</label>
        <Input id="transfer-amount" data-testid="transfer-amount-input" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0" suffix={network.ticker} inputMode="decimal" />
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
      {hash && (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 8 }}
          message="Transaction submitted"
          description={
            network.blockExplorerUrl ? (
              <a data-testid="transfer-explorer-link" href={`${network.blockExplorerUrl}/tx/${hash}`} target="_blank" rel="noopener noreferrer">
                View on explorer
              </a>
            ) : (
              <Text code style={{ wordBreak: 'break-all' }}>{hash}</Text>
            )
          }
        />
      )}
      <Button data-testid="transfer-submit-button" style={{ width: '100%', marginTop: 16 }} type="primary" htmlType="submit" loading={busy} disabled={!to || !amount}>
        Review
      </Button>
    </form>
  );
};

export default Transfer;
