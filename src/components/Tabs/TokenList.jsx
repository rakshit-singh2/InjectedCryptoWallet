import { useCallback, useEffect, useState } from 'react';
import { Alert, Avatar, Button, Input, List, Spin, message } from 'antd';
import { Contract, formatUnits, isAddress, getAddress } from 'ethers';
import { addToken, getTokens } from '../../shared/assetStore';
import { getReadProvider, formatAmount } from '../../helpers/rpc';
import CopyButton from '../CopyButton';

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

const TokenList = ({ account, network }) => {
  const [contractAddress, setContractAddress] = useState('');
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const fetchTokens = useCallback(async () => {
    const provider = getReadProvider(network);
    setLoading(true);
    setError('');
    try {
      const stored = await getTokens(account.address, network.chainId);
      setTokens(
        await Promise.all(
          stored.map(async (token) => {
            try {
              const contract = new Contract(token.address, ERC20_ABI, provider);
              const balance = await contract.balanceOf(account.address);
              return { ...token, balance: formatUnits(balance, Number(token.decimals)) };
            } catch {
              return { ...token, balance: null };
            }
          }),
        ),
      );
    } catch {
      setError('Could not load tokens.');
    } finally {
      setLoading(false);
    }
  }, [account.address, network]);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  const addContract = async (event) => {
    event.preventDefault();
    if (!isAddress(contractAddress.trim())) {
      message.error('Enter a valid contract address');
      return;
    }
    setAdding(true);
    try {
      const address = getAddress(contractAddress.trim().toLowerCase());
      const contract = new Contract(address, ERC20_ABI, getReadProvider(network));
      const [name, symbol, decimals] = await Promise.all([contract.name(), contract.symbol(), contract.decimals()]);
      await addToken(account.address, { address, name, symbol, decimals: decimals.toString(), chain: network.chainId });
      setContractAddress('');
      await fetchTokens();
    } catch (addError) {
      message.error(addError.message?.includes('already') ? addError.message : 'Not an ERC-20 contract on this network');
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <form onSubmit={addContract}>
        <Input
          data-testid="token-contract-address-input"
          aria-label="Token contract address"
          value={contractAddress}
          onChange={(e) => setContractAddress(e.target.value)}
          placeholder="ERC-20 contract address"
        />
        <Button data-testid="add-token-button" style={{ width: '100%', margin: '12px 0' }} type="primary" htmlType="submit" loading={adding}>
          Add Token
        </Button>
      </form>
      {loading ? (
        <Spin />
      ) : error ? (
        <Alert type="error" showIcon message={error} />
      ) : tokens.length ? (
        <List
          bordered
          dataSource={tokens}
          renderItem={(item) => (
            <List.Item key={item.address}>
              <List.Item.Meta avatar={<Avatar>{item.symbol?.[0]}</Avatar>} title={item.symbol} description={item.name} />
              <div style={{ textAlign: 'right' }}>
                <div>{item.balance === null ? '—' : formatAmount(item.balance)}</div>
                <CopyButton content={item.address} testId={`copy-token-address-${item.address.toLowerCase()}`} label="Copy token address" />
              </div>
            </List.Item>
          )}
        />
      ) : (
        <span>No tokens yet. Add a token contract to track it.</span>
      )}
    </>
  );
};

export default TokenList;
