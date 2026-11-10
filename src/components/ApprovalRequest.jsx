import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Spin, Tag, Typography } from 'antd';
import { formatUnits } from 'ethers';
import EnterPassword from './EnterPassword';
import { BrandLogo } from './Brand';
import { walletApi } from '../helpers/walletApi';
import { formatAmount, shortAddress } from '../helpers/rpc';

const { Title, Text, Paragraph } = Typography;
const POLL_MS = 1500;
// When a different request moves to the front, keep "approve" disabled briefly so a click aimed at
// the previous request cannot land on the new one (sites control when their prompts time out).
const ARM_DELAY_MS = 1000;

function Origin({ origin }) {
  const insecure = origin.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
  return (
    <div className="approval-origin" data-testid="approval-origin">
      <Text strong style={{ wordBreak: 'break-all' }}>{origin}</Text>
      {insecure && <Tag color="red" style={{ marginLeft: 6 }}>Not secure</Tag>}
    </div>
  );
}

function AccountLabel({ address, accounts }) {
  const account = accounts.find((a) => a.address.toLowerCase() === address?.toLowerCase());
  return (
    <span style={{ wordBreak: 'break-all' }}>
      {account ? `${account.name} (${shortAddress(address)})` : address}
    </span>
  );
}

function ConnectBody({ accounts, selectedAddress, chosen, setChosen }) {
  return (
    <>
      <Paragraph>Choose the accounts this site may see. It will be able to request signatures and transactions from them.</Paragraph>
      <div style={{ display: 'grid', gap: 6, textAlign: 'left' }}>
        {accounts.map((account) => (
          <Checkbox
            key={account.address}
            data-testid={`connect-account-checkbox-${account.address.toLowerCase()}`}
            checked={chosen.includes(account.address)}
            onChange={(e) =>
              setChosen((current) => (e.target.checked ? [...current, account.address] : current.filter((a) => a !== account.address)))
            }
          >
            {account.name} ({shortAddress(account.address)}){account.address === selectedAddress ? ' · selected' : ''}
          </Checkbox>
        ))}
      </div>
    </>
  );
}

function CalldataWarning({ calldata, ticker }) {
  if (!calldata) {
    return null;
  }
  if (calldata.kind === 'erc20-approve') {
    return (
      <Alert
        type={calldata.unlimited ? 'error' : 'warning'}
        showIcon
        message={calldata.unlimited ? 'Unlimited token approval' : 'Token approval'}
        description={`Allows ${calldata.spender} to spend ${calldata.unlimited ? 'ALL of this token' : `${calldata.amount} base units of this token`} from your account.`}
      />
    );
  }
  if (calldata.kind === 'set-approval-for-all') {
    return (
      <Alert
        type={calldata.approved ? 'error' : 'info'}
        showIcon
        message={calldata.approved ? 'Approval for ALL NFTs in a collection' : 'Revoke NFT collection approval'}
        description={`Operator: ${calldata.operator}`}
      />
    );
  }
  if (calldata.kind === 'erc20-transfer') {
    return <Alert type="info" showIcon message="Token transfer" description={`Recipient: ${calldata.recipient}, amount: ${calldata.amount} base units`} />;
  }
  return (
    <Alert
      type="info"
      showIcon
      message="Contract interaction"
      description={`Function ${calldata.selector}, ${calldata.bytes} bytes of data. Only continue if you trust this site and contract. Native value is in ${ticker}.`}
    />
  );
}

function TransactionBody({ params, accounts }) {
  const fee = params.type === 2 ? `max ${formatUnits(BigInt(params.maxFeePerGas), 'gwei')} gwei` : `${formatUnits(BigInt(params.gasPrice), 'gwei')} gwei`;
  return (
    <>
      {params.batch && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          data-testid="approval-batch-step"
          message={`Step ${params.batch.index} of ${params.batch.total} of a batch`}
          description="The earlier calls in this batch are already confirmed. Its network fee could only be calculated now. Rejecting stops the rest of the batch."
        />
      )}
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="Network">{params.networkName} ({params.chainId})</Descriptions.Item>
        <Descriptions.Item label="From"><AccountLabel address={params.from} accounts={accounts} /></Descriptions.Item>
        <Descriptions.Item label="To">{params.to ? <span style={{ wordBreak: 'break-all' }}>{params.to}</span> : <Tag color="orange">Contract deployment</Tag>}</Descriptions.Item>
        <Descriptions.Item label="Value">{params.display.valueEther} {params.ticker}</Descriptions.Item>
        <Descriptions.Item label="Gas limit">{BigInt(params.gasLimit).toString()}</Descriptions.Item>
        <Descriptions.Item label="Gas price">{fee}</Descriptions.Item>
        <Descriptions.Item label="Max fee">{formatAmount(params.display.maxFeeEther, 6)} {params.ticker}</Descriptions.Item>
        <Descriptions.Item label="Max total">{formatAmount(params.display.maxTotalEther, 6)} {params.ticker}</Descriptions.Item>
      </Descriptions>
      <div style={{ marginTop: 8 }}>
        <CalldataWarning calldata={params.display.calldata} ticker={params.ticker} />
      </div>
      {params.data !== '0x' && (
        <details style={{ marginTop: 8, textAlign: 'left' }}>
          <summary data-testid="approval-raw-data-toggle">Raw data</summary>
          <pre className="approval-pre">{params.data}</pre>
        </details>
      )}
    </>
  );
}

function BatchBody({ params, accounts }) {
  return (
    <>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 8 }}
        data-testid="approval-batch-warning"
        message={`${params.calls.length} transactions, sent one after another`}
        description="They are not all-or-nothing. Each is sent only after the previous one succeeds, and the batch stops at the first failure — but transactions already confirmed stay on chain."
      />
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="Network">{params.networkName} ({params.chainId})</Descriptions.Item>
        <Descriptions.Item label="From"><AccountLabel address={params.from} accounts={accounts} /></Descriptions.Item>
        <Descriptions.Item label="Total value">{params.totals.valueEther} {params.ticker}</Descriptions.Item>
        <Descriptions.Item label="Max fee">
          {formatAmount(params.totals.maxFeeEther, 6)} {params.ticker}
          {params.totals.deferred > 0 && ` + ${params.totals.deferred} fee(s) confirmed separately`}
        </Descriptions.Item>
      </Descriptions>
      {params.calls.map((call, index) => (
        <div key={index} className="approval-batch-call" data-testid={`approval-batch-call-${index + 1}`}>
          <Text strong>{index + 1}. </Text>
          {call.to ? <span style={{ wordBreak: 'break-all' }}>{call.to}</span> : <Tag color="orange">Contract deployment</Tag>}
          <div>Value: {call.valueEther} {params.ticker}</div>
          <div>
            {call.maxFeeEther !== null
              ? `Max fee: ${formatAmount(call.maxFeeEther, 6)} ${params.ticker}`
              : 'Fee: calculated after the previous call confirms — you will be asked to confirm it.'}
          </div>
          <div style={{ marginTop: 4 }}>
            <CalldataWarning calldata={call.calldata} ticker={params.ticker} />
          </div>
          {call.data !== '0x' && (
            <details style={{ marginTop: 4 }}>
              <summary data-testid={`approval-batch-raw-data-toggle-${index + 1}`}>Raw data</summary>
              <pre className="approval-pre">{call.data}</pre>
            </details>
          )}
        </div>
      ))}
    </>
  );
}

function ApprovalBody({ approval, state, chosen, setChosen }) {
  const { type, params } = approval;
  switch (type) {
    case 'connect':
      return <ConnectBody accounts={state.accounts} selectedAddress={state.selectedAddress} chosen={chosen} setChosen={setChosen} />;
    case 'unlock':
      return <Paragraph>This site was connected before and is asking to reconnect.</Paragraph>;
    case 'switchChain':
      return <Paragraph>Switch the wallet&apos;s network to <Text strong>{params.name}</Text> ({params.chainId})?</Paragraph>;
    case 'addChain':
      return (
        <>
          <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="A malicious network can report false balances and track your activity. Only add networks you trust." />
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Name">{params.network.name}</Descriptions.Item>
            <Descriptions.Item label="Chain ID">{BigInt(params.network.chainId).toString()} ({params.network.chainId})</Descriptions.Item>
            <Descriptions.Item label="Currency">{params.network.ticker}</Descriptions.Item>
            <Descriptions.Item label="RPC URL"><span style={{ wordBreak: 'break-all' }}>{params.network.rpcUrl}</span></Descriptions.Item>
            <Descriptions.Item label="Explorer"><span style={{ wordBreak: 'break-all' }}>{params.network.blockExplorerUrl || '—'}</span></Descriptions.Item>
          </Descriptions>
          <Paragraph style={{ marginTop: 8 }}>Approving adds the network and switches to it.</Paragraph>
        </>
      );
    case 'watchAsset':
      return (
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="Token">{params.symbol}</Descriptions.Item>
          <Descriptions.Item label="Contract"><span style={{ wordBreak: 'break-all' }}>{params.address}</span></Descriptions.Item>
          <Descriptions.Item label="Decimals">{params.decimals}</Descriptions.Item>
          <Descriptions.Item label="Account"><AccountLabel address={params.account} accounts={state.accounts} /></Descriptions.Item>
        </Descriptions>
      );
    case 'personalSign':
      return (
        <>
          <Paragraph>Sign this message with <AccountLabel address={params.from} accounts={state.accounts} />?</Paragraph>
          {!params.isText && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="This message is not readable text. Only sign it if you trust the site." />}
          <pre className="approval-pre" data-testid="approval-message">{params.preview}</pre>
        </>
      );
    case 'typedSign':
      return (
        <>
          <Paragraph>
            Sign typed data with <AccountLabel address={params.from} accounts={state.accounts} />?
            {params.version === 'v3' && <Tag style={{ marginLeft: 6 }}>EIP-712 v3</Tag>}
          </Paragraph>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Type">{params.primaryType}</Descriptions.Item>
            {params.domain.name && <Descriptions.Item label="App">{String(params.domain.name)}</Descriptions.Item>}
            {params.domain.chainId !== undefined && <Descriptions.Item label="Chain">{String(params.domain.chainId)}</Descriptions.Item>}
            {params.domain.verifyingContract && (
              <Descriptions.Item label="Contract"><span style={{ wordBreak: 'break-all' }}>{String(params.domain.verifyingContract)}</span></Descriptions.Item>
            )}
          </Descriptions>
          {params.strippedFields?.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message="This request included extra fields that are NOT part of the signature and were hidden."
              description={params.strippedFields.join(', ')}
            />
          )}
          <pre className="approval-pre" data-testid="approval-message">{JSON.stringify(params.message, null, 2)}</pre>
        </>
      );
    case 'transaction':
      return <TransactionBody params={params} accounts={state.accounts} />;
    case 'batch':
      return <BatchBody params={params} accounts={state.accounts} />;
    default:
      return <Alert type="error" message="Unknown request type" />;
  }
}

const TITLES = {
  connect: 'Connect to this site?',
  unlock: 'Unlock to reconnect',
  switchChain: 'Switch network?',
  addChain: 'Add network?',
  watchAsset: 'Add token?',
  personalSign: 'Signature request',
  typedSign: 'Signature request',
  transaction: 'Confirm transaction',
  batch: 'Confirm batch of transactions',
};

const APPROVE_LABELS = {
  connect: 'Connect',
  unlock: 'Continue',
  switchChain: 'Switch network',
  addChain: 'Add and switch',
  watchAsset: 'Add token',
  personalSign: 'Sign',
  typedSign: 'Sign',
  transaction: 'Confirm',
  batch: 'Confirm batch',
};

function ApprovalRequest() {
  const [state, setState] = useState(null);
  const [approvals, setApprovals] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  const load = useCallback(async () => {
    if (closingRef.current) {
      return null; // a released window must not pick up requests now routed to a new window
    }
    try {
      const [nextState, nextApprovals] = await Promise.all([walletApi.getState(), walletApi.listApprovals()]);
      setState(nextState);
      setApprovals(nextApprovals);
      return nextApprovals;
    } catch (loadError) {
      setError(loadError.message);
      return null;
    }
  }, []);

  useEffect(() => {
    load();
    // Polling picks up queued requests and keeps the worker alive while the user decides.
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const current = approvals?.[0];
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (current?.type === 'connect' && state?.selectedAddress) {
      setChosen([state.selectedAddress]);
    }
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (approvals && approvals.length === 0) {
      // Ask the background before closing: it refuses if a new request was routed here meanwhile,
      // otherwise it detaches this window so the close cannot reject a request that arrives later.
      const timer = setTimeout(async () => {
        const released = await walletApi.releaseApprovalWindow().catch(() => false);
        if (released) {
          closingRef.current = true;
          setClosing(true);
          window.close();
        } else {
          load();
        }
      }, 600);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [approvals, load]);

  const decide = async (approved) => {
    setSubmitting(true);
    setError('');
    try {
      await walletApi.resolveApproval(current.id, approved, current.type === 'connect' ? { accounts: chosen } : undefined);
      await load();
    } catch (decideError) {
      setError(decideError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const rejectAllFromSite = async () => {
    setSubmitting(true);
    try {
      await walletApi.rejectApprovalsFromOrigin(current.origin);
      await load();
    } catch (rejectError) {
      setError(rejectError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const sameSiteCount = approvals?.filter((approval) => approval.origin === current?.origin).length ?? 0;

  if (closing) {
    return <Card style={{ margin: 16 }}><Text>Done.</Text></Card>;
  }

  if (!state || !approvals) {
    return error ? <Alert style={{ margin: 16 }} type="error" message={error} /> : <Spin style={{ marginTop: 48 }} />;
  }

  if (!current) {
    return <Card style={{ margin: 16 }}><Text>No pending requests.</Text></Card>;
  }

  if (!state.unlocked) {
    return (
      <div style={{ padding: 16, width: '100%' }}>
        <Origin origin={current.origin} />
        <Paragraph>Unlock the wallet to review this request.</Paragraph>
        <EnterPassword mode="unlock" compact onDone={load} />
        <Button data-testid="approval-reject-button" block danger style={{ marginTop: 12 }} onClick={() => decide(false)}>
          Reject
        </Button>
      </div>
    );
  }

  return (
    <Card style={{ margin: 12, width: 'calc(100% - 24px)', textAlign: 'left' }}>
      <div className="approval-brand"><BrandLogo size={22} /></div>
      {approvals.length > 1 && <Tag data-testid="approval-queue-count">1 of {approvals.length}</Tag>}
      <Title level={4}>{TITLES[current.type] || 'Request'}</Title>
      <Origin origin={current.origin} />
      <div style={{ margin: '12px 0' }}>
        <ApprovalBody approval={current} state={state} chosen={chosen} setChosen={setChosen} />
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button data-testid="approval-reject-button" block disabled={submitting} onClick={() => decide(false)}>
          Reject
        </Button>
        <Button
          data-testid="approval-approve-button"
          block
          type="primary"
          loading={submitting}
          disabled={!armed || (current.type === 'connect' && chosen.length === 0)}
          onClick={() => decide(true)}
        >
          {APPROVE_LABELS[current.type] || 'Approve'}
        </Button>
      </div>
      {sameSiteCount > 1 && (
        <Button data-testid="approval-reject-all-from-site-button" type="link" danger block disabled={submitting} onClick={rejectAllFromSite} style={{ marginTop: 8 }}>
          Reject all {sameSiteCount} requests from this site
        </Button>
      )}
    </Card>
  );
}

export default ApprovalRequest;
