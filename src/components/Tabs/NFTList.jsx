import { useCallback, useEffect, useState } from 'react';
import { Alert, Avatar, Button, Input, List, Spin, message } from 'antd';
import { Contract, isAddress, getAddress } from 'ethers';
import { addNFT, getNFTs } from '../../shared/assetStore';
import { getReadProvider } from '../../helpers/rpc';
import NFTabi from '../../ABI/NFTabi.json';
import CopyButton from '../CopyButton';

const ERC721_INTERFACE = '0x80ac58cd';
const ERC1155_INTERFACE = '0xd9b67a26';

const NFTList = ({ account, network }) => {
  const [contractAddress, setContractAddress] = useState('');
  const [nfts, setNFTs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const fetchNFTs = useCallback(async () => {
    const provider = getReadProvider(network);
    setLoading(true);
    setError('');
    try {
      const stored = await getNFTs(account.address, network.chainId);
      setNFTs(
        await Promise.all(
          stored.map(async (nft) => {
            try {
              const balance = await new Contract(nft.address, NFTabi, provider).balanceOf(account.address);
              return { ...nft, balance: balance.toString() };
            } catch {
              return { ...nft, balance: null };
            }
          }),
        ),
      );
    } catch {
      setError('Could not load NFTs.');
    } finally {
      setLoading(false);
    }
  }, [account.address, network]);

  useEffect(() => {
    fetchNFTs();
  }, [fetchNFTs]);

  const addContract = async (event) => {
    event.preventDefault();
    if (!isAddress(contractAddress.trim())) {
      message.error('Enter a valid contract address');
      return;
    }
    setAdding(true);
    try {
      const address = getAddress(contractAddress.trim().toLowerCase());
      const contract = new Contract(address, NFTabi, getReadProvider(network));
      const [is721, is1155] = await Promise.all([
        contract.supportsInterface(ERC721_INTERFACE).catch(() => false),
        contract.supportsInterface(ERC1155_INTERFACE).catch(() => false),
      ]);
      if (!is721 && !is1155) {
        throw new Error('Not an NFT contract on this network');
      }
      const [name, symbol] = await Promise.all([contract.name().catch(() => 'NFT'), contract.symbol().catch(() => '')]);
      await addNFT(account.address, { address, name, symbol, standard: is721 ? 'ERC-721' : 'ERC-1155', chain: network.chainId });
      setContractAddress('');
      await fetchNFTs();
    } catch (addError) {
      message.error(addError.message || 'Could not add NFT contract');
    } finally {
      setAdding(false);
    }
  };

  return (
    <>
      <form onSubmit={addContract}>
        <Input
          data-testid="nft-contract-address-input"
          aria-label="NFT contract address"
          value={contractAddress}
          onChange={(e) => setContractAddress(e.target.value)}
          placeholder="NFT contract address"
        />
        <Button data-testid="add-nft-button" style={{ width: '100%', margin: '12px 0' }} type="primary" htmlType="submit" loading={adding}>
          Add NFT Collection
        </Button>
      </form>
      {loading ? (
        <Spin />
      ) : error ? (
        <Alert type="error" showIcon message={error} />
      ) : nfts.length ? (
        <List
          bordered
          dataSource={nfts}
          renderItem={(item) => (
            <List.Item key={item.address}>
              <List.Item.Meta avatar={<Avatar>{item.symbol?.[0] || 'N'}</Avatar>} title={item.symbol || item.name} description={item.name} />
              <div style={{ textAlign: 'right' }}>
                <div>{item.balance === null ? '—' : `${item.balance} owned`}</div>
                <CopyButton content={item.address} testId={`copy-nft-address-${item.address.toLowerCase()}`} label="Copy NFT contract address" />
              </div>
            </List.Item>
          )}
        />
      ) : (
        <span>No NFT collections yet.</span>
      )}
    </>
  );
};

export default NFTList;
