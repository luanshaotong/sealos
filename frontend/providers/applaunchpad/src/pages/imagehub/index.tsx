import { getImageHubs } from '@/api/app';
import SwitchPage from '@/components/ImageHub/SwitchPage';
import List from '@/components/ImageHub/list';
import { useLoading } from '@/hooks/useLoading';
import { serviceSideProps } from '@/utils/i18n';
import { getUserNamespace } from '@/utils/user';
import { Flex } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useState } from 'react';

const Home = ({ namespace }: { namespace: string }) => {
  const router = useRouter();
  const { Loading } = useLoading();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState('created');
  const [sortOrder, setSortOrder] = useState('desc');

  const { isLoading, data, refetch } = useQuery(
    ['getImageHubs', page, pageSize, searchTerm, sortBy, sortOrder],
    () => getImageHubs({ page, pageSize, search: searchTerm, sortBy, sortOrder }),
    {
      retry: 3
    }
  );

  return (
    <Flex backgroundColor={'grayModern.100'} px={'32px'} h={'100vh'} flexDirection={'column'}>
      <List
        namespaces={[]}
        apps={data?.items || []}
        refetchApps={refetch}
        onSearch={setSearchTerm}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSortChange={(newSortBy: string, newSortOrder: string) => {
          setSortBy(newSortBy);
          setSortOrder(newSortOrder);
        }}
      />

      <SwitchPage
        flexShrink={0}
        my={'8px'}
        justifyContent={'end'}
        currentPage={page}
        totalPage={data?.totalPages || 0}
        totalItem={data?.total || 0}
        pageSize={pageSize}
        setCurrentPage={(idx: number) => setPage(idx)}
      />
      <Loading loading={isLoading} />
    </Flex>
  );
};

export async function getServerSideProps(content: any) {
  const namespace = content?.query?.namespace || 'default';
  return {
    props: {
      namespace,
      ...(await serviceSideProps(content))
    }
  };
}

export default Home;
