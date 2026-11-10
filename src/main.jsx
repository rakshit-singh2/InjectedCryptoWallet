import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { MemoryRouter } from 'react-router';
import App from './App.jsx';
import { antdTheme } from './theme';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConfigProvider theme={antdTheme}>
      <MemoryRouter initialEntries={[window.location.hash.startsWith('#/') ? window.location.hash.slice(1) : '/']}>
        <App />
      </MemoryRouter>
    </ConfigProvider>
  </React.StrictMode>,
);
