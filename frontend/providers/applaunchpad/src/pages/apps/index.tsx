import { useLoading } from '@/hooks/useLoading';
import { useAppStore } from '@/store/app';
import { AppListItemType } from '@/types/app';
import { serviceSideProps } from '@/utils/i18n';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RequestController, isElementInViewport } from '@/utils/tools';
import AppList from './components/appList';
import { getCurrentNamespace } from '@/utils/user';

const Home = ({ namespace, page: initialPage, pageSize: initialPageSize }: { 
  namespace: string;
  page: number;
  pageSize: number;
}) => {
  const router = useRouter();
  const { appList, namespaces, pagination, setAppList, intervalLoadPods, loadAvgMonitorData } = useAppStore();
  const { Loading } = useLoading();
  const [refresh, setFresh] = useState(false);
  const list = useRef<AppListItemType[]>(appList);
  const currentNamespace = useRef<string>(namespace);
  const namespacesRef = useRef<string[]>(namespaces);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [currentPageSize, setCurrentPageSize] = useState(initialPageSize);

  currentNamespace.current = getCurrentNamespace(currentNamespace.current);

  const refreshList = useCallback(
    (res = appList) => {
      list.current = res;
      namespacesRef.current = namespaces;
      setFresh((state) => !state);
      return null;
    },
    [appList, namespaces]
  );

  const { isLoading, refetch: refetchAppList } = useQuery(
    ['appListQuery', currentNamespace.current, currentPage, currentPageSize],
    () => setAppList(currentNamespace.current, currentPage, currentPageSize, false),
    {
      onSettled(res) {
        if (!res) return;
        refreshList(res.apps);
      }
    }
  );

  const requestController = useRef(new RequestController());

  useQuery(
    ['intervalLoadPods', appList.length],
    () => {
      const doms = document.querySelectorAll(`.appItem`);
      const viewportDomIds = Array.from(doms)
        .filter((item) => isElementInViewport(item))
        .map((item) => item.getAttribute('data-id'));

      const viewportApps =
        viewportDomIds.length < 3
          ? appList
          : appList.filter((app) => viewportDomIds.includes(app.id));

      return requestController.current.runTasks({
        tasks: viewportApps
          .filter((app) => !app.isPause)
          .map((app) => {
            return () => intervalLoadPods(currentNamespace.current, app.name, false);
          }),
        limit: 3
      });
    },
    {
      refetchOnMount: true,
      refetchInterval: 3000,
      onSettled() {
        refreshList();
      }
    }
  );

  useQuery(
    ['refresh'],
    () => {
      refreshList();
      return null;
    },
    {
      refetchInterval: 3000
    }
  );

  const { refetch: refetchAvgMonitorData } = useQuery(
    ['loadAvgMonitorData', appList.length],
    () => {
      const doms = document.querySelectorAll(`.appItem`);
      const viewportDomIds = Array.from(doms)
        .filter((item) => isElementInViewport(item))
        .map((item) => item.getAttribute('data-id'));

      const viewportApps =
        viewportDomIds.length < 3
          ? appList
          : appList.filter((app) => viewportDomIds.includes(app.id));

      return requestController.current.runTasks({
        tasks: viewportApps
          .filter((app) => !app.isPause)
          .map((app) => {
            return () => loadAvgMonitorData(currentNamespace.current, app.name);
          }),
        limit: 3
      });
    },
    {
      refetchOnMount: true,
      refetchInterval: 2 * 60 * 1000,
      onError(err) {
        console.log(err);
      },
      onSettled() {
        refreshList();
      }
    }
  );

  useEffect(() => {
    router.prefetch('/app/detail');
    router.prefetch('/app/edit');

    return () => {
      requestController.current?.stop();
    };
  }, [router]);

  // 更新URL参数的函数
  const updateUrlParams = useCallback((newPage: number, newPageSize: number, namespace: string) => {
    const query = { ...router.query };
    query.page = newPage.toString();
    query.pageSize = newPageSize.toString();
    query.namespace = namespace;
    router.push({
      pathname: router.pathname,
      query
    }, undefined, { shallow: true });
  }, [router]);

  return (
    <>
      <AppList
        namespaces={namespacesRef.current}
        currentNamespace={currentNamespace.current}
        apps={list.current}
        pagination={pagination}
        refetchApps={(namespace: string, page?: number, pageSize?: number) => {
          currentNamespace.current = namespace;
          if (page !== undefined) {
            setCurrentPage(page);
            updateUrlParams(page, pageSize || currentPageSize, namespace);
          }
          if (pageSize !== undefined) {
            setCurrentPageSize(pageSize);
            updateUrlParams(page || currentPage, pageSize, namespace);
          }
          refetchAppList();
          refetchAvgMonitorData();
        }}
      />
      <Loading loading={isLoading} />
    </>
  );
};

export async function getServerSideProps(content: any) {
  const namespace = content?.query?.namespace || 'default';
  const page = parseInt(content?.query?.page as string) || 1;
  const pageSize = parseInt(content?.query?.pageSize as string) || 10;
  
  return {
    props: {
      namespace,
      page,
      pageSize,
      ...(await serviceSideProps(content))
    }
  };
}

export default Home;
